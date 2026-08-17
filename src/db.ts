import { Database } from "bun:sqlite";
import { parseRuntimeBinding, type RuntimeBinding } from "./runtime-bundle.ts";
import { isRecord } from "./type-guards.ts";
import { getManifestRole, parseResolvedManifest, relationFromNode } from "./manifest.ts";
export type OperationKind =
  | "workspace_create"
  | "spawn"
  | "worktree_create"
  | "tab_create"
  | "agent_start"
  | "prompt"
  | "step"
  | "merge"
  | "cancel"
  | "quiesce"
  | "message";
export type OperationStatus =
  | "reserved"
  | "submitted"
  | "delivery_unknown"
  | "observed"
  | "completed"
  | "cancelled"
  | "failed"
  | "blocked";
export type NodeLifecycleStatus =
  | "reserved"
  | "worktree_ready"
  | "agent_ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancel_requested"
  | "interrupting"
  | "terminating"
  | "force_terminating"
  | "cancelled"
  | "cancel_blocked";

export class OperationConflictError extends Error {
  constructor(readonly requestKey: string) {
    super(`operation request key ${requestKey} was reused with different content`);
    this.name = "OperationConflictError";
  }
}

export type TreeStatus =
  | "initializing"
  | "active"
  | "completed"
  | "failed"
  | "blocked"
  | "cancel_requested"
  | "cancelling"
  | "cancelled"
  | "cancel_blocked"
  | "cleaned";

export interface TreeRecord {
  treeId: string;
  runId: string;
  repoRoot: string;
  repoSourceWorkspaceId: string | null;
  herdrSocketPath: string;
  herdrVersion: string;
  herdrProtocol: number;
  runtimeBinding: RuntimeBinding;
  baseCommit: string;
  worktreeRoot: string;
  rootTaskContract: string;
  rootSpawnPolicy: NodeSpawnPolicy;
  manifestDigest: string | null;
  rootRole: string | null;
  status: TreeStatus;
  generation: number;
}

export type NodePlacement = "workspace" | "tab";
export type NodeSpawnPolicy = "none" | "workspace" | "tab" | "both";

export interface NodeRecord {
  nodeId: string;
  treeId: string;
  parentNodeId: string | null;
  name: string;
  depth: number;
  placement: NodePlacement;
  spawnPolicy: NodeSpawnPolicy;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
  agentName: string | null;
  agentSession: string | null;
  terminalId: string | null;
  agentInstanceId: string | null;
  lifecycleStatus: NodeLifecycleStatus;
  taskContract: string;
  roleName: string | null;
  roleDigest: string | null;
  parameters: unknown;
  resolvedCapabilities: unknown;
  generation: number;
}

export interface ManifestRecord {
  manifestDigest: string;
  apiVersion: string;
  resolved: unknown;
}

export type CreateTreeInput = Omit<
  TreeRecord,
  "status" | "generation" | "rootSpawnPolicy" | "manifestDigest" | "rootRole" | "runtimeBinding"
> & {
  status?: TreeStatus;
  rootSpawnPolicy?: NodeSpawnPolicy;
  manifestDigest?: string | null;
  rootRole?: string | null;
  runtimeBinding?: RuntimeBinding;
};

export interface OperationRecord {
  operationId: string;
  treeId: string;
  nodeId: string | null;
  kind: OperationKind;
  requestKey: string;
  requestHash: string;
  status: OperationStatus;
  attempt: number;
  request: unknown;
  result: unknown | null;
  lastError: string | null;
}

export interface StepExecutionRecord {
  operationId: string;
  nodeId: string;
  status: "reserved" | "claimed" | "completed" | "failed" | "cancelled";
  claimCount: number;
  agentSession: string | null;
  commitSha: string | null;
  resultMessageId: string | null;
}

export interface MessageRecord {
  messageId: string;
  treeId: string;
  senderNodeId: string;
  recipientNodeId: string;
  channel: "inbox" | "outbox" | "public" | "private";
  kind: "progress" | "result";
  priority: number;
  replyToMessageId: string | null;
  body: string;
}

export type CleanupPlanStatus = "applying" | "completed";

export interface CleanupPlanRecord {
  planDigest: string;
  treeId: string;
  treeGeneration: number;
  manifestDigest: string | null;
  plan: unknown;
  status: CleanupPlanStatus;
}

export interface CleanupReceiptRecord {
  planDigest: string;
  actionIndex: number;
  actionKind: string;
  target: string;
  outcome: "removed" | "already_absent";
  details: unknown;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS manifests (
  manifest_digest TEXT PRIMARY KEY,
  api_version TEXT NOT NULL,
  resolved_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS trees (
  tree_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  repo_root TEXT NOT NULL,
  repo_source_workspace_id TEXT,
  herdr_socket_path TEXT NOT NULL,
  herdr_version TEXT NOT NULL,
  herdr_protocol INTEGER NOT NULL,
  runtime_binding_json TEXT NOT NULL DEFAULT '{"mode":"external"}',
  base_commit TEXT NOT NULL,
  worktree_root TEXT NOT NULL,
  root_task_contract TEXT NOT NULL,
  root_spawn_policy TEXT NOT NULL DEFAULT 'none' CHECK(root_spawn_policy IN ('none', 'workspace', 'tab', 'both')),
  manifest_digest TEXT,
  root_role TEXT,
  status TEXT NOT NULL DEFAULT 'initializing',
  generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
  parent_node_id TEXT REFERENCES nodes(node_id),
  name TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(depth >= 0),
  placement TEXT NOT NULL DEFAULT 'workspace' CHECK(placement IN ('workspace', 'tab')),
  spawn_policy TEXT NOT NULL DEFAULT 'none' CHECK(spawn_policy IN ('none', 'workspace', 'tab', 'both')),
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  workspace_id TEXT,
  tab_id TEXT,
  pane_id TEXT,
  agent_name TEXT,
  agent_session TEXT,
  terminal_id TEXT,
  agent_instance_id TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'reserved',
  task_contract TEXT NOT NULL,
  role_name TEXT,
  role_digest TEXT,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  resolved_capabilities_json TEXT NOT NULL DEFAULT '{}',
  generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tree_id, parent_node_id, name)
) STRICT;
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(node_id),
  kind TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  attempt INTEGER NOT NULL DEFAULT 0,
  request_json TEXT NOT NULL,
  result_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tree_id, kind, request_key)
) STRICT;
CREATE TABLE IF NOT EXISTS step_executions (
  operation_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  run_number INTEGER NOT NULL,
  iteration_number INTEGER NOT NULL,
  step_number INTEGER NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  claimed_by_agent_session TEXT,
  claim_count INTEGER NOT NULL DEFAULT 0,
  commit_sha TEXT,
  result_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
  sender_node_id TEXT NOT NULL REFERENCES nodes(node_id),
  recipient_node_id TEXT NOT NULL REFERENCES nodes(node_id),
  channel TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'progress' CHECK(kind IN ('progress', 'result')),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 10),
  reply_to_message_id TEXT REFERENCES messages(message_id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS receipts (
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  reader_node_id TEXT NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(message_id, reader_node_id)
) STRICT;
CREATE TABLE IF NOT EXISTS cleanup_plans (
  plan_digest TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES trees(tree_id),
  tree_generation INTEGER NOT NULL,
  manifest_digest TEXT,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applying',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS cleanup_receipts (
  plan_digest TEXT NOT NULL REFERENCES cleanup_plans(plan_digest),
  action_index INTEGER NOT NULL,
  action_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL,
  details_json TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY(plan_digest, action_index)
) STRICT;
`;

const SQLITE_BUSY_RETRY_WINDOW_MS = 5_000;

function now(): number {
  return Date.now();
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : (JSON.parse(value) as unknown);
}

type TreeRow = Omit<TreeRecord, "runtimeBinding"> & { runtimeBindingJson: string };

function treeFromRow(row: TreeRow): TreeRecord {
  const { runtimeBindingJson, ...record } = row;
  return {
    ...record,
    runtimeBinding: parseRuntimeBinding(JSON.parse(runtimeBindingJson)),
  };
}

function cleanupPlanManifestDigest(plan: unknown): string | null {
  if (!isRecord(plan) || !Object.hasOwn(plan, "manifestDigest")) {
    throw new Error("cleanup plan payload is missing manifest identity");
  }
  const manifestDigest = plan.manifestDigest;
  if (manifestDigest !== null && typeof manifestDigest !== "string") {
    throw new Error("cleanup plan payload manifest identity is invalid");
  }
  return manifestDigest;
}

type NodeRow = Omit<NodeRecord, "parameters" | "resolvedCapabilities"> & {
  parametersJson: string;
  resolvedCapabilitiesJson: string;
};

function nodeFromRow(row: NodeRow): NodeRecord {
  const { parametersJson, resolvedCapabilitiesJson, ...record } = row;
  return {
    ...record,
    parameters: parseJson(parametersJson) ?? {},
    resolvedCapabilities: parseJson(resolvedCapabilitiesJson) ?? {},
  };
}

export class SheltieStore {
  private readonly database: Database;

  constructor(readonly path: string) {
    this.database = new Database(path, { create: true, strict: true });
    // SQLite retries lock acquisition inside sqlite3_step, preserving the surrounding statement/transaction boundary.
    this.database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_RETRY_WINDOW_MS}`);
    this.database.exec(SCHEMA);
    this.migrateSchema();
  }

  close(): void {
    this.database.close();
  }

  saveManifest(input: ManifestRecord): ManifestRecord {
    const existing = this.getManifest(input.manifestDigest);
    if (existing !== null) {
      if (existing.apiVersion !== input.apiVersion || JSON.stringify(existing.resolved) !== JSON.stringify(input.resolved)) {
        throw new OperationConflictError(input.manifestDigest);
      }
      return existing;
    }
    this.database
      .query(`INSERT INTO manifests (manifest_digest, api_version, resolved_json, created_at)
        VALUES (?, ?, ?, ?)`)
      .run(input.manifestDigest, input.apiVersion, JSON.stringify(input.resolved), now());
    const stored = this.getManifest(input.manifestDigest);
    if (stored === null) throw new Error(`manifest ${input.manifestDigest} was not stored`);
    return stored;
  }

  getManifest(manifestDigest: string): ManifestRecord | null {
    const row = this.database
      .query(`SELECT manifest_digest AS manifestDigest, api_version AS apiVersion,
        resolved_json AS resolvedJson FROM manifests WHERE manifest_digest = ?`)
      .get(manifestDigest) as { manifestDigest: string; apiVersion: string; resolvedJson: string } | null;
    if (row === null) return null;
    return {
      manifestDigest: row.manifestDigest,
      apiVersion: row.apiVersion,
      resolved: parseJson(row.resolvedJson),
    };
  }

  createManifestTree(manifest: ManifestRecord, tree: CreateTreeInput): TreeRecord {
    const transaction = this.database.transaction(() => {
      this.saveManifest(manifest);
      return this.createTree(tree);
    });
    return transaction();
  }

  createTree(input: CreateTreeInput): TreeRecord {
    const runtimeBinding = parseRuntimeBinding(input.runtimeBinding ?? { mode: "external" });
    const timestamp = now();
    this.database
      .query(`INSERT INTO trees (
        tree_id, run_id, repo_root, repo_source_workspace_id, herdr_socket_path,
        herdr_version, herdr_protocol, runtime_binding_json, base_commit, worktree_root, root_task_contract,
        root_spawn_policy, manifest_digest, root_role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.treeId,
        input.runId,
        input.repoRoot,
        input.repoSourceWorkspaceId,
        input.herdrSocketPath,
        input.herdrVersion,
        input.herdrProtocol,
        JSON.stringify(runtimeBinding),
        input.baseCommit,
        input.worktreeRoot,
        input.rootTaskContract,
        input.rootSpawnPolicy ?? "none",
        input.manifestDigest ?? null,
        input.rootRole ?? null,
        input.status ?? "initializing",
        timestamp,
        timestamp,
      );
    return this.getTree(input.treeId);
  }

  getTree(treeId: string): TreeRecord {
    const row = this.database
      .query(`SELECT tree_id AS treeId, run_id AS runId, repo_root AS repoRoot,
        repo_source_workspace_id AS repoSourceWorkspaceId, herdr_socket_path AS herdrSocketPath,
        herdr_version AS herdrVersion, herdr_protocol AS herdrProtocol,
        runtime_binding_json AS runtimeBindingJson, base_commit AS baseCommit, worktree_root AS worktreeRoot,
        root_task_contract AS rootTaskContract, root_spawn_policy AS rootSpawnPolicy,
        manifest_digest AS manifestDigest, root_role AS rootRole,
        status, generation FROM trees WHERE tree_id = ?`)
      .get(treeId) as TreeRow | null;
    if (row === null) throw new Error(`tree ${treeId} not found`);
    return treeFromRow(row);
  }

  getOnlyTree(): TreeRecord {
    const rows = this.database.query("SELECT tree_id AS treeId FROM trees ORDER BY created_at").all() as {
      treeId: string;
    }[];
    if (rows.length !== 1) throw new Error(`expected exactly one tree in ${this.path}; found ${rows.length}`);
    return this.getTree(rows[0]!.treeId);
  }

  bindRepoSourceWorkspace(treeId: string, workspaceId: string): TreeRecord {
    this.database
      .query(`UPDATE trees SET repo_source_workspace_id = ?, generation = generation + 1,
        updated_at = ? WHERE tree_id = ?`)
      .run(workspaceId, now(), treeId);
    return this.getTree(treeId);
  }

  setTreeStatus(treeId: string, status: TreeStatus): TreeRecord {
    this.database
      .query(`UPDATE trees SET status = ?,
        generation = generation + CASE WHEN status = ? THEN 0 ELSE 1 END,
        updated_at = ? WHERE tree_id = ?`)
      .run(status, status, now(), treeId);
    return this.getTree(treeId);
  }

  findRootNode(treeId: string): NodeRecord | null {
    const row = this.database
      .query("SELECT node_id AS nodeId FROM nodes WHERE tree_id = ? AND parent_node_id IS NULL")
      .get(treeId) as { nodeId: string } | null;
    return row === null ? null : this.getNode(row.nodeId);
  }

  reserveNode(input: {
    nodeId: string;
    treeId: string;
    parentNodeId: string | null;
    name: string;
    depth: number;
    placement?: NodePlacement;
    spawnPolicy?: NodeSpawnPolicy;
    branch: string;
    baseCommit: string;
    worktreePath: string;
    taskContract: string;
    roleName?: string | null;
    roleDigest?: string | null;
    parameters?: unknown;
    resolvedCapabilities?: unknown;
  }): NodeRecord {
    const existing = this.database
      .query("SELECT node_id AS nodeId FROM nodes WHERE tree_id = ? AND parent_node_id IS ? AND name = ?")
      .get(input.treeId, input.parentNodeId, input.name) as { nodeId: string } | null;
    if (existing !== null) return this.getNode(existing.nodeId);
    const timestamp = now();
    this.database
      .query(`INSERT INTO nodes (
        node_id, tree_id, parent_node_id, name, depth, placement, spawn_policy,
        branch, base_commit, worktree_path, task_contract, role_name, role_digest,
        parameters_json, resolved_capabilities_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.nodeId,
        input.treeId,
        input.parentNodeId,
        input.name,
        input.depth,
        input.placement ?? "workspace",
        input.spawnPolicy ?? "both",
        input.branch,
        input.baseCommit,
        input.worktreePath,
        input.taskContract,
        input.roleName ?? null,
        input.roleDigest ?? null,
        JSON.stringify(input.parameters ?? {}),
        JSON.stringify(input.resolvedCapabilities ?? {}),
        timestamp,
        timestamp,
      );
    return this.getNode(input.nodeId);
  }

  findChildNode(parentNodeId: string, name: string): NodeRecord | null {
    const row = this.database
      .query("SELECT node_id AS nodeId FROM nodes WHERE parent_node_id = ? AND name = ?")
      .get(parentNodeId, name) as { nodeId: string } | null;
    return row === null ? null : this.getNode(row.nodeId);
  }

  reserveChildNode(
    input: {
      nodeId: string;
      treeId: string;
      parentNodeId: string;
      name: string;
      placement?: NodePlacement;
      depth: number;
      spawnPolicy?: NodeSpawnPolicy;
      branch: string;
      baseCommit: string;
      worktreePath: string;
      taskContract: string;
      roleName?: string | null;
      roleDigest?: string | null;
      parameters?: unknown;
      resolvedCapabilities?: unknown;
    },
    limits: { maxDepth: number; maxChildren: number; maxDescendants: number },
  ): NodeRecord {
    const transaction = this.database.transaction(() => {
      const existing = this.database
        .query("SELECT node_id AS nodeId FROM nodes WHERE tree_id = ? AND parent_node_id = ? AND name = ?")
        .get(input.treeId, input.parentNodeId, input.name) as { nodeId: string } | null;
      if (existing !== null) {
        const node = this.getNode(existing.nodeId);
        const placement = input.placement ?? "workspace";
        if (
          node.nodeId !== input.nodeId ||
          node.depth !== input.depth ||
          node.placement !== placement ||
          node.branch !== input.branch ||
          node.baseCommit !== input.baseCommit ||
          node.spawnPolicy !== (input.spawnPolicy ?? "both") ||
          node.worktreePath !== input.worktreePath ||
          node.taskContract !== input.taskContract ||
          node.roleName !== (input.roleName ?? null) ||
          node.roleDigest !== (input.roleDigest ?? null) ||
          JSON.stringify(node.parameters) !== JSON.stringify(input.parameters ?? {}) ||
          JSON.stringify(node.resolvedCapabilities) !== JSON.stringify(input.resolvedCapabilities ?? {})
        ) {
          throw new OperationConflictError(`${input.parentNodeId}/${input.name}`);
        }
        return node;
      }
      const tree = this.getTree(input.treeId);
      if (tree.status !== "active") {
        throw new Error(`tree ${tree.treeId} is cancelling or terminal (${tree.status})`);
      }
      const parent = this.getNode(input.parentNodeId);
      if (parent.treeId !== input.treeId || input.depth !== parent.depth + 1) {
        throw new Error("child node lineage does not match its parent");
      }
      if (input.depth > limits.maxDepth) {
        throw new Error(`child depth ${input.depth} exceeds max depth ${limits.maxDepth}`);
      }
      const directChildren = this.database
        .query(`SELECT COUNT(*) AS count FROM nodes
          WHERE tree_id = ? AND parent_node_id = ? AND lifecycle_status NOT IN ('completed', 'failed')`)
        .get(input.treeId, input.parentNodeId) as { count: number };
      if (directChildren.count >= limits.maxChildren) {
        throw new Error(`parent ${input.parentNodeId} reached max children ${limits.maxChildren}`);
      }
      const descendants = this.database
        .query(`WITH RECURSIVE descendants(node_id) AS (
          SELECT node_id FROM nodes WHERE parent_node_id = ?
          UNION ALL
          SELECT nodes.node_id FROM nodes JOIN descendants ON nodes.parent_node_id = descendants.node_id
        ) SELECT COUNT(*) AS count FROM descendants`)
        .get(input.parentNodeId) as { count: number };
      if (descendants.count >= limits.maxDescendants) {
        throw new Error(`parent ${input.parentNodeId} reached max descendants ${limits.maxDescendants}`);
      }
      return this.reserveNode(input);
    });
    return transaction();
  }

  getNode(nodeId: string): NodeRecord {
    const row = this.database
      .query(`SELECT node_id AS nodeId, tree_id AS treeId, parent_node_id AS parentNodeId,
        name, depth, placement, spawn_policy AS spawnPolicy, branch,
        base_commit AS baseCommit, worktree_path AS worktreePath,
        workspace_id AS workspaceId, tab_id AS tabId, pane_id AS paneId,
        agent_name AS agentName, agent_session AS agentSession,
        terminal_id AS terminalId, agent_instance_id AS agentInstanceId,
        lifecycle_status AS lifecycleStatus, task_contract AS taskContract,
        role_name AS roleName, role_digest AS roleDigest, parameters_json AS parametersJson,
        resolved_capabilities_json AS resolvedCapabilitiesJson, generation
        FROM nodes WHERE node_id = ?`)
      .get(nodeId) as NodeRow | null;
    if (row === null) throw new Error(`node ${nodeId} not found`);
    return nodeFromRow(row);
  }

  listNodes(treeId: string): NodeRecord[] {
    const rows = this.database
      .query(`SELECT node_id AS nodeId, tree_id AS treeId, parent_node_id AS parentNodeId,
        name, depth, placement, spawn_policy AS spawnPolicy, branch,
        base_commit AS baseCommit, worktree_path AS worktreePath,
        workspace_id AS workspaceId, tab_id AS tabId, pane_id AS paneId,
        agent_name AS agentName, agent_session AS agentSession,
        terminal_id AS terminalId, agent_instance_id AS agentInstanceId,
        lifecycle_status AS lifecycleStatus, task_contract AS taskContract,
        role_name AS roleName, role_digest AS roleDigest, parameters_json AS parametersJson,
        resolved_capabilities_json AS resolvedCapabilitiesJson, generation
        FROM nodes WHERE tree_id = ? ORDER BY depth, created_at`)
      .all(treeId) as NodeRow[];
    return rows.map(nodeFromRow);
  }

  findNodeByPane(paneId: string): NodeRecord | null {
    const row = this.database
      .query(`SELECT node_id AS nodeId, tree_id AS treeId, parent_node_id AS parentNodeId,
        name, depth, placement, spawn_policy AS spawnPolicy, branch,
        base_commit AS baseCommit, worktree_path AS worktreePath,
        workspace_id AS workspaceId, tab_id AS tabId, pane_id AS paneId,
        agent_name AS agentName, agent_session AS agentSession,
        terminal_id AS terminalId, agent_instance_id AS agentInstanceId,
        lifecycle_status AS lifecycleStatus, task_contract AS taskContract,
        role_name AS roleName, role_digest AS roleDigest, parameters_json AS parametersJson,
        resolved_capabilities_json AS resolvedCapabilitiesJson, generation
        FROM nodes WHERE pane_id = ?`)
      .get(paneId) as NodeRow | null;
    return row === null ? null : nodeFromRow(row);
  }

  bindWorktree(nodeId: string, input: { workspaceId: string; tabId: string; paneId: string }): NodeRecord {
    this.database
      .query(`UPDATE nodes SET workspace_id = ?, tab_id = ?, pane_id = ?,
        lifecycle_status = 'worktree_ready', updated_at = ? WHERE node_id = ?`)
      .run(input.workspaceId, input.tabId, input.paneId, now(), nodeId);
    return this.getNode(nodeId);
  }

  bindAgent(
    nodeId: string,
    input: {
      agentName: string;
      agentSession?: string | null;
      terminalId: string;
      agentInstanceId: string;
    },
  ): NodeRecord {
    this.database
      .query(`UPDATE nodes SET agent_name = ?, agent_session = ?, terminal_id = ?,
        agent_instance_id = ?, lifecycle_status = 'agent_ready', updated_at = ? WHERE node_id = ?`)
      .run(
        input.agentName,
        input.agentSession ?? null,
        input.terminalId,
        input.agentInstanceId,
        now(),
        nodeId,
      );
    return this.getNode(nodeId);
  }

  setNodeLifecycle(nodeId: string, status: NodeLifecycleStatus): NodeRecord {
    this.database
      .query("UPDATE nodes SET lifecycle_status = ?, updated_at = ? WHERE node_id = ?")
      .run(status, now(), nodeId);
    return this.getNode(nodeId);
  }

  requestCancellation(): TreeRecord {
    const transaction = this.database.transaction(() => {
      const tree = this.getOnlyTree();
      if (tree.status === "completed" || tree.status === "failed" || tree.status === "cancelled" || tree.status === "cleaned") {
        return tree;
      }
      this.setTreeStatus(tree.treeId, "cancel_requested");
      this.database
        .query(`UPDATE nodes SET lifecycle_status = 'cancel_requested', updated_at = ?
          WHERE tree_id = ? AND lifecycle_status NOT IN ('completed', 'failed', 'cancelled')`)
        .run(now(), tree.treeId);
      return this.getTree(tree.treeId);
    });
    return transaction();
  }

  completeNodeCancellation(
    cancelOperationId: string,
    nodeId: string,
    result: Record<string, unknown>,
  ): void {
    const transaction = this.database.transaction(() => {
      this.database
        .query(`UPDATE step_executions SET status = 'cancelled', updated_at = ?
          WHERE node_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`)
        .run(now(), nodeId);
      this.database
        .query(`UPDATE operations SET status = 'cancelled', updated_at = ?
          WHERE node_id = ? AND operation_id != ?
            AND status NOT IN ('completed', 'failed', 'cancelled')`)
        .run(now(), nodeId, cancelOperationId);
      this.setNodeLifecycle(nodeId, "cancelled");
      this.setOperationStatus(cancelOperationId, "completed", {
        result,
        lastError: null,
      });
    });
    transaction();
  }

  finishNode(nodeId: string, paneId: string): NodeRecord {
    const transaction = this.database.transaction(() => {
      const node = this.getNode(nodeId);
      if (node.paneId !== paneId) {
        throw new Error(`node ${nodeId} is not bound to pane ${paneId}`);
      }
      if (node.lifecycleStatus === "completed") return node;
      const steps = this.database
        .query(`SELECT COUNT(*) AS total,
          SUM(CASE WHEN status != 'completed' THEN 1 ELSE 0 END) AS unfinished
          FROM step_executions WHERE node_id = ?`)
        .get(nodeId) as { total: number; unfinished: number | null };
      if (steps.total === 0 || (steps.unfinished ?? 0) !== 0) {
        throw new Error(`node ${nodeId} has unfinished steps`);
      }
      const children = this.database
        .query(`SELECT COUNT(*) AS unfinished FROM nodes
          WHERE parent_node_id = ? AND lifecycle_status != 'completed'`)
        .get(nodeId) as { unfinished: number };
      if (children.unfinished !== 0) {
        throw new Error(`node ${nodeId} has unfinished children`);
      }
      const unmergedChildren = this.database
        .query(`SELECT COUNT(*) AS count
          FROM nodes child
          LEFT JOIN operations merge_operation
            ON merge_operation.tree_id = child.tree_id
            AND merge_operation.node_id = child.parent_node_id
            AND merge_operation.kind = 'merge'
            AND merge_operation.request_key = child.node_id
            AND merge_operation.status = 'completed'
          WHERE child.parent_node_id = ? AND child.placement = 'workspace'
            AND merge_operation.operation_id IS NULL`)
        .get(nodeId) as { count: number };
      if (unmergedChildren.count !== 0) {
        throw new Error(`node ${nodeId} has unmerged children`);
      }
      return this.setNodeLifecycle(nodeId, "completed");
    });
    return transaction();
  }

  reserveOperation(input: {
    operationId: string;
    treeId: string;
    nodeId: string | null;
    kind: OperationKind;
    requestKey: string;
    requestHash: string;
    request: unknown;
  }): OperationRecord {
    const existing = this.database
      .query("SELECT operation_id AS operationId, request_hash AS requestHash FROM operations WHERE tree_id = ? AND kind = ? AND request_key = ?")
      .get(input.treeId, input.kind, input.requestKey) as
      | { operationId: string; requestHash: string }
      | null;
    if (existing !== null) {
      if (existing.requestHash !== input.requestHash) throw new OperationConflictError(input.requestKey);
      return this.getOperation(existing.operationId);
    }
    const timestamp = now();
    this.database
      .query(`INSERT INTO operations (
        operation_id, tree_id, node_id, kind, request_key, request_hash, request_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.operationId,
        input.treeId,
        input.nodeId,
        input.kind,
        input.requestKey,
        input.requestHash,
        JSON.stringify(input.request),
        timestamp,
        timestamp,
      );
    return this.getOperation(input.operationId);
  }

  reserveParentMergeOperation(input: {
    operationId: string;
    treeId: string;
    parentNodeId: string;
    childNodeId: string;
    requestHash: string;
    request: unknown;
  }): OperationRecord {
    const transaction = this.database.transaction(() => {
      const existing = this.database
        .query(`SELECT operation_id AS operationId FROM operations
          WHERE tree_id = ? AND kind = 'merge' AND request_key = ?`)
        .get(input.treeId, input.childNodeId) as { operationId: string } | null;
      if (existing !== null) {
        const operation = this.getOperation(existing.operationId);
        if (operation.requestHash !== input.requestHash) throw new OperationConflictError(input.childNodeId);
        return operation;
      }
      const active = this.database
        .query(`SELECT operation_id AS operationId FROM operations
          WHERE tree_id = ? AND node_id = ? AND kind = 'merge'
            AND status IN ('reserved', 'submitted', 'delivery_unknown', 'blocked')
          LIMIT 1`)
        .get(input.treeId, input.parentNodeId) as { operationId: string } | null;
      if (active !== null) {
        throw new Error(`parent ${input.parentNodeId} already has active merge ${active.operationId}`);
      }
      return this.reserveOperation({
        operationId: input.operationId,
        treeId: input.treeId,
        nodeId: input.parentNodeId,
        kind: "merge",
        requestKey: input.childNodeId,
        requestHash: input.requestHash,
        request: input.request,
      });
    });
    return transaction();
  }

  findOperation(operationId: string): OperationRecord | null {
    const row = this.database
      .query(`SELECT operation_id AS operationId, tree_id AS treeId, node_id AS nodeId, kind,
        request_key AS requestKey, request_hash AS requestHash, status, attempt,
        request_json AS requestJson, result_json AS resultJson, last_error AS lastError
        FROM operations WHERE operation_id = ?`)
      .get(operationId) as
      | (Omit<OperationRecord, "request" | "result"> & { requestJson: string; resultJson: string | null })
      | null;
    if (row === null) return null;
    const { requestJson, resultJson, ...record } = row;
    return { ...record, request: parseJson(requestJson), result: parseJson(resultJson) };
  }

  getOperation(operationId: string): OperationRecord {
    const operation = this.findOperation(operationId);
    if (operation === null) throw new Error(`operation ${operationId} not found`);
    return operation;
  }

  setOperationStatus(
    operationId: string,
    status: OperationStatus,
    options: { result?: unknown; lastError?: string | null; incrementAttempt?: boolean } = {},
  ): OperationRecord {
    const current = this.getOperation(operationId);
    this.database
      .query(`UPDATE operations SET status = ?, attempt = ?, result_json = ?, last_error = ?, updated_at = ?
        WHERE operation_id = ?`)
      .run(
        status,
        current.attempt + (options.incrementAttempt === true ? 1 : 0),
        options.result === undefined ? JSON.stringify(current.result) : JSON.stringify(options.result),
        options.lastError === undefined ? current.lastError : options.lastError,
        now(),
        operationId,
      );
    return this.getOperation(operationId);
  }

  listOperations(treeId: string): OperationRecord[] {
    const rows = this.database
      .query("SELECT operation_id AS operationId FROM operations WHERE tree_id = ? ORDER BY created_at")
      .all(treeId) as { operationId: string }[];
    return rows.map(({ operationId }) => this.getOperation(operationId));
  }

  listUnresolvedOperations(treeId: string): OperationRecord[] {
    return this.listOperations(treeId).filter(
      (operation) => !["completed", "failed", "cancelled"].includes(operation.status),
    );
  }

  reserveStep(input: {
    operationId: string;
    nodeId: string;
    runNumber: number;
    iterationNumber: number;
    stepNumber: number;
    promptSha256: string;
  }): void {
    const existing = this.database
      .query(`SELECT node_id AS nodeId, prompt_sha256 AS promptSha256
        FROM step_executions WHERE operation_id = ?`)
      .get(input.operationId) as { nodeId: string; promptSha256: string } | null;
    if (existing !== null) {
      if (existing.nodeId !== input.nodeId || existing.promptSha256 !== input.promptSha256) {
        throw new OperationConflictError(input.operationId);
      }
      return;
    }
    const timestamp = now();
    this.database
      .query(`INSERT INTO step_executions (
        operation_id, node_id, run_number, iteration_number, step_number, prompt_sha256,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.operationId,
        input.nodeId,
        input.runNumber,
        input.iterationNumber,
        input.stepNumber,
        input.promptSha256,
        timestamp,
        timestamp,
      );
  }

  claimStep(
    operationId: string,
    agentSession: string,
  ):
    | { outcome: "claimed" | "already_claimed" | "conflict" }
    | { outcome: "completed"; commitSha: string | null } {
    const transaction = this.database.transaction(() => {
      const row = this.database
        .query(`SELECT status, claimed_by_agent_session AS agentSession, commit_sha AS commitSha
          FROM step_executions WHERE operation_id = ?`)
        .get(operationId) as { status: string; agentSession: string | null; commitSha: string | null } | null;
      if (row === null) throw new Error(`step ${operationId} not found`);
      if (row.status === "completed") return { outcome: "completed" as const, commitSha: row.commitSha };
      if (row.status === "claimed") {
        return { outcome: row.agentSession === agentSession ? ("already_claimed" as const) : ("conflict" as const) };
      }
      const changed = this.database
        .query(`UPDATE step_executions SET status = 'claimed', claimed_by_agent_session = ?,
          claim_count = claim_count + 1, updated_at = ?
          WHERE operation_id = ? AND status = 'reserved'`)
        .run(agentSession, now(), operationId).changes;
      return { outcome: changed === 1 ? ("claimed" as const) : ("conflict" as const) };
    });
    return transaction();
  }

  getStep(operationId: string): StepExecutionRecord {
    const row = this.database
      .query(`SELECT operation_id AS operationId, node_id AS nodeId, status,
        claimed_by_agent_session AS agentSession, claim_count AS claimCount,
        commit_sha AS commitSha, result_message_id AS resultMessageId
        FROM step_executions WHERE operation_id = ?`)
      .get(operationId) as StepExecutionRecord | null;
    if (row === null) throw new Error(`step ${operationId} not found`);
    return row;
  }

  listSteps(treeId: string): StepExecutionRecord[] {
    const rows = this.database
      .query(`SELECT steps.operation_id AS operationId
        FROM step_executions steps JOIN nodes ON nodes.node_id = steps.node_id
        WHERE nodes.tree_id = ? ORDER BY steps.created_at`)
      .all(treeId) as { operationId: string }[];
    return rows.map(({ operationId }) => this.getStep(operationId));
  }

  getLatestCompletedStepCommit(nodeId: string): string {
    const row = this.database
      .query(`SELECT commit_sha AS commitSha FROM step_executions
        WHERE node_id = ? AND status = 'completed' AND commit_sha IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`)
      .get(nodeId) as { commitSha: string } | null;
    if (row === null) throw new Error(`node ${nodeId} has no completed step commit`);
    return row.commitSha;
  }

  completeStep(input: {
    operationId: string;
    agentSession: string;
    commitSha: string;
    resultMessageId: string | null;
  }): void {
    const changed = this.database
      .query(`UPDATE step_executions SET status = 'completed', commit_sha = ?, result_message_id = ?,
        updated_at = ? WHERE operation_id = ? AND status = 'claimed' AND claimed_by_agent_session = ?`)
      .run(input.commitSha, input.resultMessageId, now(), input.operationId, input.agentSession).changes;
    if (changed !== 1) throw new Error(`step ${input.operationId} is not claimed by ${input.agentSession}`);
  }

  sendMessage(input: MessageRecord): MessageRecord {
    const transaction = this.database.transaction(() => {
      if (input.kind !== "progress" && input.kind !== "result") {
        throw new Error(`message kind ${String(input.kind)} is invalid`);
      }
      const sender = this.getNode(input.senderNodeId);
      const recipient = this.getNode(input.recipientNodeId);
      if (sender.treeId !== input.treeId || recipient.treeId !== input.treeId) {
        throw new Error("message sender and recipient must belong to the declared tree");
      }
      if (input.kind === "result" && sender.lifecycleStatus !== "completed") {
        throw new Error(`result message sender ${sender.nodeId} is not completed`);
      }
      const tree = this.getTree(input.treeId);
      if (tree.manifestDigest !== null) {
        if (sender.roleName === null || recipient.roleName === null) {
          throw new Error("manifest message participants must have role identities");
        }
        const record = this.getManifest(tree.manifestDigest);
        if (record === null) throw new Error(`tree ${tree.treeId} manifest ${tree.manifestDigest} is missing`);
        const manifest = parseResolvedManifest(record.resolved);
        const senderRole = getManifestRole(manifest, sender.roleName);
        const recipientRole = getManifestRole(manifest, recipient.roleName);
        const senderRelation = relationFromNode(sender, recipient);
        const recipientRelation = relationFromNode(recipient, sender);
        if (senderRelation === null || !senderRole.capabilities.messaging.sendTo.includes(senderRelation)) {
          throw new Error(`role ${senderRole.name} cannot send messages to node ${recipient.nodeId}`);
        }
        if (recipientRelation === null || !recipientRole.capabilities.messaging.receiveFrom.includes(recipientRelation)) {
          throw new Error(`role ${recipientRole.name} cannot receive messages from node ${sender.nodeId}`);
        }
      }
      this.database
        .query(`INSERT INTO messages (
          message_id, tree_id, sender_node_id, recipient_node_id, channel, kind, priority,
          reply_to_message_id, body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.messageId,
          input.treeId,
          input.senderNodeId,
          input.recipientNodeId,
          input.channel,
          input.kind,
          input.priority,
          input.replyToMessageId,
          input.body,
          now(),
        );
      return input;
    });
    return transaction();
  }

  listMessages(treeId: string): MessageRecord[] {
    return this.database
      .query(`SELECT message_id AS messageId, tree_id AS treeId,
        sender_node_id AS senderNodeId, recipient_node_id AS recipientNodeId,
        channel, kind, priority, reply_to_message_id AS replyToMessageId, body
        FROM messages WHERE tree_id = ? ORDER BY created_at`)
      .all(treeId) as MessageRecord[];
  }

  hasUnreadInbox(nodeId: string): boolean {
    return (
      this.database
        .query(`SELECT 1 FROM messages AS message
          LEFT JOIN receipts AS receipt
            ON receipt.message_id = message.message_id AND receipt.reader_node_id = ?
          WHERE message.recipient_node_id = ? AND message.channel = 'inbox'
            AND receipt.message_id IS NULL
          LIMIT 1`)
        .get(nodeId, nodeId) !== null
    );
  }

  syncInbox(nodeId: string): MessageRecord[] {
    const transaction = this.database.transaction(() => {
      const messages = this.database
        .query(`SELECT m.message_id AS messageId, m.tree_id AS treeId,
          m.sender_node_id AS senderNodeId, m.recipient_node_id AS recipientNodeId,
          m.channel, m.kind, m.priority, m.reply_to_message_id AS replyToMessageId, m.body
          FROM messages m LEFT JOIN receipts r
            ON r.message_id = m.message_id AND r.reader_node_id = ?
          WHERE m.recipient_node_id = ? AND m.channel = 'inbox' AND r.message_id IS NULL
          ORDER BY m.priority DESC, m.created_at`)
        .all(nodeId, nodeId) as MessageRecord[];
      const receipt = this.database.query(
        "INSERT OR IGNORE INTO receipts (message_id, reader_node_id, read_at) VALUES (?, ?, ?)",
      );
      const timestamp = now();
      for (const message of messages) receipt.run(message.messageId, nodeId, timestamp);
      return messages;
    });
    return transaction();
  }

  hasReadReceipt(messageId: string, nodeId: string): boolean {
    return (
      this.database.query("SELECT 1 FROM receipts WHERE message_id = ? AND reader_node_id = ?").get(messageId, nodeId) !==
      null
    );
  }

  getCleanupPlan(planDigest: string): CleanupPlanRecord | null {
    const row = this.database
      .query(`SELECT plan_digest AS planDigest, tree_id AS treeId,
        tree_generation AS treeGeneration, manifest_digest AS manifestDigest, plan_json AS planJson, status
        FROM cleanup_plans WHERE plan_digest = ?`)
      .get(planDigest) as
      | (Omit<CleanupPlanRecord, "plan"> & { planJson: string })
      | null;
    if (row === null) return null;
    const { planJson, ...record } = row;
    return { ...record, plan: parseJson(planJson) };
  }

  getLatestCompletedCleanupPlan(treeId: string): CleanupPlanRecord | null {
    const row = this.database
      .query(`SELECT plan_digest AS planDigest FROM cleanup_plans
        WHERE tree_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1`)
      .get(treeId) as { planDigest: string } | null;
    return row === null ? null : this.getCleanupPlan(row.planDigest);
  }

  createCleanupPlan(input: {
    planDigest: string;
    treeId: string;
    treeGeneration: number;
    manifestDigest: string | null;
    plan: unknown;
  }): CleanupPlanRecord {
    const tree = this.getTree(input.treeId);
    if (
      tree.generation !== input.treeGeneration ||
      tree.manifestDigest !== input.manifestDigest ||
      cleanupPlanManifestDigest(input.plan) !== input.manifestDigest
    ) {
      throw new Error(`cleanup plan ${input.planDigest} manifest identity does not match its tree and payload`);
    }
    const existing = this.getCleanupPlan(input.planDigest);
    if (existing !== null) {
      if (
        existing.treeId !== input.treeId ||
        existing.treeGeneration !== input.treeGeneration ||
        existing.manifestDigest !== input.manifestDigest ||
        JSON.stringify(existing.plan) !== JSON.stringify(input.plan)
      ) {
        throw new Error(`cleanup plan ${input.planDigest} conflicts with its persisted receipt`);
      }
      return existing;
    }
    const timestamp = now();
    this.database
      .query(`INSERT INTO cleanup_plans (
        plan_digest, tree_id, tree_generation, manifest_digest, plan_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'applying', ?, ?)`)
      .run(
        input.planDigest,
        input.treeId,
        input.treeGeneration,
        input.manifestDigest,
        JSON.stringify(input.plan),
        timestamp,
        timestamp,
      );
    return this.getCleanupPlan(input.planDigest) as CleanupPlanRecord;
  }

  recordCleanupReceipt(input: CleanupReceiptRecord): CleanupReceiptRecord {
    this.database
      .query(`INSERT OR IGNORE INTO cleanup_receipts (
        plan_digest, action_index, action_kind, target, outcome, details_json, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.planDigest,
        input.actionIndex,
        input.actionKind,
        input.target,
        input.outcome,
        JSON.stringify(input.details),
        now(),
      );
    const receipt = this.database
      .query(`SELECT plan_digest AS planDigest, action_index AS actionIndex,
        action_kind AS actionKind, target, outcome, details_json AS detailsJson
        FROM cleanup_receipts WHERE plan_digest = ? AND action_index = ?`)
      .get(input.planDigest, input.actionIndex) as
      | (Omit<CleanupReceiptRecord, "details"> & { detailsJson: string })
      | null;
    if (receipt === null) throw new Error(`cleanup receipt ${input.planDigest}/${input.actionIndex} was not stored`);
    const { detailsJson, ...record } = receipt;
    return { ...record, details: parseJson(detailsJson) };
  }

  listCleanupReceipts(planDigest: string): CleanupReceiptRecord[] {
    const rows = this.database
      .query(`SELECT action_index AS actionIndex FROM cleanup_receipts
        WHERE plan_digest = ? ORDER BY action_index`)
      .all(planDigest) as { actionIndex: number }[];
    return rows.map(({ actionIndex }) => {
      const row = this.database
        .query(`SELECT plan_digest AS planDigest, action_index AS actionIndex,
          action_kind AS actionKind, target, outcome, details_json AS detailsJson
          FROM cleanup_receipts WHERE plan_digest = ? AND action_index = ?`)
        .get(planDigest, actionIndex) as Omit<CleanupReceiptRecord, "details"> & { detailsJson: string };
      const { detailsJson, ...record } = row;
      return { ...record, details: parseJson(detailsJson) };
    });
  }

  completeCleanupPlan(planDigest: string): TreeRecord {
    const transaction = this.database.transaction(() => {
      const plan = this.getCleanupPlan(planDigest);
      if (plan === null) throw new Error(`cleanup plan ${planDigest} not found`);
      const receipts = this.listCleanupReceipts(planDigest);
      const actionCount = isRecord(plan.plan) && Array.isArray(plan.plan.actions)
        ? plan.plan.actions.length
        : -1;
      if (receipts.length !== actionCount) {
        throw new Error(`cleanup plan ${planDigest} has ${receipts.length}/${actionCount} action receipts`);
      }
      const tree = this.getTree(plan.treeId);
      if (tree.status !== "cleaned") this.setTreeStatus(tree.treeId, "cleaned");
      this.database
        .query("UPDATE cleanup_plans SET status = 'completed', updated_at = ? WHERE plan_digest = ?")
        .run(now(), planDigest);
      return this.getTree(plan.treeId);
    });
    return transaction();
  }

  private migrateSchema(): void {
    const treeColumns = this.database.query("PRAGMA table_info(trees)").all() as { name: string }[];
    if (!treeColumns.some((column) => column.name === "generation")) {
      this.database.exec("ALTER TABLE trees ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    }
    if (!treeColumns.some((column) => column.name === "runtime_binding_json")) {
      this.database.exec(
        `ALTER TABLE trees ADD COLUMN runtime_binding_json TEXT NOT NULL DEFAULT '{"mode":"external"}'`,
      );
    }
    if (!treeColumns.some((column) => column.name === "root_spawn_policy")) {
      this.database.exec(`ALTER TABLE trees ADD COLUMN root_spawn_policy TEXT NOT NULL DEFAULT 'none'
        CHECK(root_spawn_policy IN ('none', 'workspace', 'tab', 'both'))`);
    }
    if (!treeColumns.some((column) => column.name === "manifest_digest")) {
      this.database.exec("ALTER TABLE trees ADD COLUMN manifest_digest TEXT");
    }
    if (!treeColumns.some((column) => column.name === "root_role")) {
      this.database.exec("ALTER TABLE trees ADD COLUMN root_role TEXT");
    }
    const cleanupPlanColumns = this.database.query("PRAGMA table_info(cleanup_plans)").all() as { name: string }[];
    if (!cleanupPlanColumns.some((column) => column.name === "manifest_digest")) {
      this.database.exec("ALTER TABLE cleanup_plans ADD COLUMN manifest_digest TEXT");
      this.database.exec(`UPDATE cleanup_plans
        SET manifest_digest = (
          SELECT manifest_digest FROM trees WHERE trees.tree_id = cleanup_plans.tree_id
        )
        WHERE manifest_digest IS NULL`);
    }
    const messageColumns = this.database.query("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!messageColumns.some((column) => column.name === "kind")) {
      this.database.exec(`ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'progress'
        CHECK(kind IN ('progress', 'result'))`);
      this.database.exec("UPDATE messages SET kind = 'progress'");
    }
    const nodeColumns = this.database.query("PRAGMA table_info(nodes)").all() as { name: string }[];
    if (!nodeColumns.some((column) => column.name === "placement")) {
      this.database.exec("PRAGMA foreign_keys = OFF");
      try {
        this.database.exec(`BEGIN IMMEDIATE;
          CREATE TABLE nodes_v2 (
            node_id TEXT PRIMARY KEY,
            tree_id TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
            parent_node_id TEXT REFERENCES nodes_v2(node_id),
            name TEXT NOT NULL,
            depth INTEGER NOT NULL CHECK(depth >= 0),
            placement TEXT NOT NULL DEFAULT 'workspace' CHECK(placement IN ('workspace', 'tab')),
            spawn_policy TEXT NOT NULL DEFAULT 'none' CHECK(spawn_policy IN ('none', 'workspace', 'tab', 'both')),
            branch TEXT NOT NULL,
            base_commit TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            workspace_id TEXT,
            tab_id TEXT,
            pane_id TEXT,
            agent_name TEXT,
            agent_session TEXT,
            terminal_id TEXT,
            agent_instance_id TEXT,
            lifecycle_status TEXT NOT NULL DEFAULT 'reserved',
            task_contract TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(tree_id, parent_node_id, name)
          ) STRICT;
          INSERT INTO nodes_v2 (
            node_id, tree_id, parent_node_id, name, depth, placement, spawn_policy,
            branch, base_commit, worktree_path, workspace_id, tab_id, pane_id, agent_name,
            agent_session, terminal_id, agent_instance_id, lifecycle_status, task_contract,
            generation, created_at, updated_at
          )
          SELECT node_id, tree_id, parent_node_id, name, depth, 'workspace', 'both',
            branch, base_commit, worktree_path, workspace_id, tab_id, pane_id, agent_name,
            agent_session, terminal_id, agent_instance_id, lifecycle_status, task_contract,
            generation, created_at, updated_at
          FROM nodes;
          DROP TABLE nodes;
          ALTER TABLE nodes_v2 RENAME TO nodes;
          COMMIT;`);
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // The migration may have failed before BEGIN acquired the transaction.
        }
        throw error;
      } finally {
        this.database.exec("PRAGMA foreign_keys = ON");
      }
      const violations = this.database.query("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error("node placement migration violated foreign keys");
    }
    const migratedNodeColumns = this.database.query("PRAGMA table_info(nodes)").all() as { name: string }[];
    if (!migratedNodeColumns.some((column) => column.name === "spawn_policy")) {
      this.database.exec(`ALTER TABLE nodes ADD COLUMN spawn_policy TEXT NOT NULL DEFAULT 'both'
        CHECK(spawn_policy IN ('none', 'workspace', 'tab', 'both'))`);
    }
    if (!migratedNodeColumns.some((column) => column.name === "role_name")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN role_name TEXT");
    }
    if (!migratedNodeColumns.some((column) => column.name === "role_digest")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN role_digest TEXT");
    }
    if (!migratedNodeColumns.some((column) => column.name === "parameters_json")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN parameters_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!migratedNodeColumns.some((column) => column.name === "resolved_capabilities_json")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN resolved_capabilities_json TEXT NOT NULL DEFAULT '{}'");
    }
    this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS nodes_workspace_branch_unique
      ON nodes(tree_id, branch) WHERE placement = 'workspace';
      CREATE UNIQUE INDEX IF NOT EXISTS nodes_workspace_path_unique
      ON nodes(tree_id, worktree_path) WHERE placement = 'workspace'`);
  }
}
