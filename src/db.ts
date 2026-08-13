import { Database } from "bun:sqlite";

export type OperationKind =
  | "workspace_create"
  | "spawn"
  | "worktree_create"
  | "agent_start"
  | "prompt"
  | "step"
  | "merge"
  | "cancel"
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
  | "cancel_blocked";

export interface TreeRecord {
  treeId: string;
  runId: string;
  repoRoot: string;
  repoSourceWorkspaceId: string | null;
  herdrSocketPath: string;
  herdrVersion: string;
  herdrProtocol: number;
  baseCommit: string;
  worktreeRoot: string;
  rootTaskContract: string;
  status: TreeStatus;
}

export interface NodeRecord {
  nodeId: string;
  treeId: string;
  parentNodeId: string | null;
  name: string;
  depth: number;
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
  generation: number;
}

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
  priority: number;
  replyToMessageId: string | null;
  body: string;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS trees (
  tree_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  repo_root TEXT NOT NULL,
  repo_source_workspace_id TEXT,
  herdr_socket_path TEXT NOT NULL,
  herdr_version TEXT NOT NULL,
  herdr_protocol INTEGER NOT NULL,
  base_commit TEXT NOT NULL,
  worktree_root TEXT NOT NULL,
  root_task_contract TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initializing',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
  parent_node_id TEXT REFERENCES nodes(node_id),
  name TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(depth >= 0),
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
  UNIQUE(tree_id, parent_node_id, name),
  UNIQUE(tree_id, branch),
  UNIQUE(tree_id, worktree_path)
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
`;

const SQLITE_BUSY_RETRY_WINDOW_MS = 5_000;

function now(): number {
  return Date.now();
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : (JSON.parse(value) as unknown);
}

export class SheltieStore {
  private readonly database: Database;

  constructor(readonly path: string) {
    this.database = new Database(path, { create: true, strict: true });
    // SQLite retries lock acquisition inside sqlite3_step, preserving the surrounding statement/transaction boundary.
    this.database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_RETRY_WINDOW_MS}`);
    this.database.exec(SCHEMA);
  }

  close(): void {
    this.database.close();
  }

  createTree(input: Omit<TreeRecord, "status"> & { status?: TreeStatus }): TreeRecord {
    const timestamp = now();
    this.database
      .query(`INSERT INTO trees (
        tree_id, run_id, repo_root, repo_source_workspace_id, herdr_socket_path,
        herdr_version, herdr_protocol, base_commit, worktree_root, root_task_contract,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.treeId,
        input.runId,
        input.repoRoot,
        input.repoSourceWorkspaceId,
        input.herdrSocketPath,
        input.herdrVersion,
        input.herdrProtocol,
        input.baseCommit,
        input.worktreeRoot,
        input.rootTaskContract,
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
        base_commit AS baseCommit, worktree_root AS worktreeRoot,
        root_task_contract AS rootTaskContract, status
        FROM trees WHERE tree_id = ?`)
      .get(treeId) as TreeRecord | null;
    if (row === null) throw new Error(`tree ${treeId} not found`);
    return row;
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
      .query("UPDATE trees SET repo_source_workspace_id = ?, updated_at = ? WHERE tree_id = ?")
      .run(workspaceId, now(), treeId);
    return this.getTree(treeId);
  }

  setTreeStatus(treeId: string, status: TreeStatus): TreeRecord {
    this.database.query("UPDATE trees SET status = ?, updated_at = ? WHERE tree_id = ?").run(status, now(), treeId);
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
    branch: string;
    baseCommit: string;
    worktreePath: string;
    taskContract: string;
  }): NodeRecord {
    const existing = this.database
      .query("SELECT node_id AS nodeId FROM nodes WHERE tree_id = ? AND parent_node_id IS ? AND name = ?")
      .get(input.treeId, input.parentNodeId, input.name) as { nodeId: string } | null;
    if (existing !== null) return this.getNode(existing.nodeId);
    const timestamp = now();
    this.database
      .query(`INSERT INTO nodes (
        node_id, tree_id, parent_node_id, name, depth, branch, base_commit, worktree_path,
        task_contract, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.nodeId,
        input.treeId,
        input.parentNodeId,
        input.name,
        input.depth,
        input.branch,
        input.baseCommit,
        input.worktreePath,
        input.taskContract,
        timestamp,
        timestamp,
      );
    return this.getNode(input.nodeId);
  }

  reserveChildNode(
    input: {
      nodeId: string;
      treeId: string;
      parentNodeId: string;
      name: string;
      depth: number;
      branch: string;
      baseCommit: string;
      worktreePath: string;
      taskContract: string;
    },
    limits: { maxDepth: number; maxChildren: number; maxDescendants: number },
  ): NodeRecord {
    const transaction = this.database.transaction(() => {
      const existing = this.database
        .query("SELECT node_id AS nodeId FROM nodes WHERE tree_id = ? AND parent_node_id = ? AND name = ?")
        .get(input.treeId, input.parentNodeId, input.name) as { nodeId: string } | null;
      if (existing !== null) return this.getNode(existing.nodeId);
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
        name, depth, branch, base_commit AS baseCommit, worktree_path AS worktreePath,
        workspace_id AS workspaceId, tab_id AS tabId, pane_id AS paneId,
        agent_name AS agentName, agent_session AS agentSession,
        terminal_id AS terminalId, agent_instance_id AS agentInstanceId,
        lifecycle_status AS lifecycleStatus, task_contract AS taskContract, generation
        FROM nodes WHERE node_id = ?`)
      .get(nodeId) as NodeRecord | null;
    if (row === null) throw new Error(`node ${nodeId} not found`);
    return row;
  }

  listNodes(treeId: string): NodeRecord[] {
    return this.database
      .query(`SELECT node_id AS nodeId, tree_id AS treeId, parent_node_id AS parentNodeId,
        name, depth, branch, base_commit AS baseCommit, worktree_path AS worktreePath,
        workspace_id AS workspaceId, tab_id AS tabId, pane_id AS paneId,
        agent_name AS agentName, agent_session AS agentSession,
        terminal_id AS terminalId, agent_instance_id AS agentInstanceId,
        lifecycle_status AS lifecycleStatus, task_contract AS taskContract, generation
        FROM nodes WHERE tree_id = ? ORDER BY depth, created_at`)
      .all(treeId) as NodeRecord[];
  }

  findNodeByPane(paneId: string): NodeRecord | null {
    return (this.database
      .query(`SELECT node_id AS nodeId, tree_id AS treeId, parent_node_id AS parentNodeId,
        name, depth, branch, base_commit AS baseCommit, worktree_path AS worktreePath,
        workspace_id AS workspaceId, tab_id AS tabId, pane_id AS paneId,
        agent_name AS agentName, agent_session AS agentSession,
        terminal_id AS terminalId, agent_instance_id AS agentInstanceId,
        lifecycle_status AS lifecycleStatus, task_contract AS taskContract, generation
        FROM nodes WHERE pane_id = ?`)
      .get(paneId) ?? null) as NodeRecord | null;
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
      if (tree.status === "completed" || tree.status === "failed" || tree.status === "cancelled") {
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
          WHERE child.parent_node_id = ? AND merge_operation.operation_id IS NULL`)
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

  listUnresolvedOperations(treeId: string): OperationRecord[] {
    const rows = this.database
      .query(`SELECT operation_id AS operationId FROM operations
        WHERE tree_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at`)
      .all(treeId) as { operationId: string }[];
    return rows.map(({ operationId }) => this.getOperation(operationId));
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
    this.database
      .query(`INSERT INTO messages (
        message_id, tree_id, sender_node_id, recipient_node_id, channel, priority,
        reply_to_message_id, body, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.messageId,
        input.treeId,
        input.senderNodeId,
        input.recipientNodeId,
        input.channel,
        input.priority,
        input.replyToMessageId,
        input.body,
        now(),
      );
    return input;
  }

  listMessages(treeId: string): MessageRecord[] {
    return this.database
      .query(`SELECT message_id AS messageId, tree_id AS treeId,
        sender_node_id AS senderNodeId, recipient_node_id AS recipientNodeId,
        channel, priority, reply_to_message_id AS replyToMessageId, body
        FROM messages WHERE tree_id = ? ORDER BY created_at`)
      .all(treeId) as MessageRecord[];
  }

  syncInbox(nodeId: string): MessageRecord[] {
    const transaction = this.database.transaction(() => {
      const messages = this.database
        .query(`SELECT m.message_id AS messageId, m.tree_id AS treeId,
          m.sender_node_id AS senderNodeId, m.recipient_node_id AS recipientNodeId,
          m.channel, m.priority, m.reply_to_message_id AS replyToMessageId, m.body
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
}
