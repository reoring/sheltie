import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { requestHash } from "./ids.ts";
import { isRecord } from "./type-guards.ts";

export const OBSERVATION_API_VERSION = "sheltie.dev/observation/v1alpha1";
export const OBSERVATION_KIND = "ObservationSnapshot";

export type ObservationTreeStatus =
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

export type ObservationNodeLifecycleStatus =
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

export type ObservationStepStatus = "reserved" | "claimed" | "completed" | "failed" | "cancelled";
export type ObservationMessageChannel = "inbox" | "outbox" | "public" | "private";
export type ObservationPlacement = "workspace" | "tab";
export type ObservationMessageScope = "parent" | "children" | "siblings";
export type ObservationWorkspaceMode = "read-only" | "read-write";

export interface ObservationSnapshot {
  apiVersion: typeof OBSERVATION_API_VERSION;
  kind: typeof OBSERVATION_KIND;
  observedAt: string;
  run: ObservationRun;
  manifest: ObservationManifest;
  nodes: ObservationNode[];
  edges: ObservationEdge[];
  summary: ObservationSummary;
}

export interface ObservationRun {
  treeId: string;
  runId: string;
  status: ObservationTreeStatus;
  generation: number;
  manifestDigest: string;
  rootRole: string;
  baseCommit: string;
}

export interface ObservationManifest {
  apiVersion: "sheltie.dev/v1alpha1";
  name: string;
  digest: string;
  root: {
    role: string;
    name: string;
  };
  limits: {
    maxDepth: number;
    maxChildrenPerNode: number;
    maxDescendants: number;
    maxParallelNodes: number;
  };
  roles: ObservationRole[];
}

export interface ObservationRole {
  name: string;
  digest: string;
  placement: ObservationPlacement;
  allowedChildRoles: string[];
  mergeChildren: boolean;
  messaging: {
    sendTo: ObservationMessageScope[];
    receiveFrom: ObservationMessageScope[];
  };
  workspaceMode: ObservationWorkspaceMode;
}

export interface ObservationNode {
  nodeId: string;
  name: string;
  parentNodeId: string | null;
  depth: number;
  placement: ObservationPlacement;
  lifecycleStatus: ObservationNodeLifecycleStatus;
  roleName: string;
  roleDigest: string;
  generation: number;
}

export interface ObservationEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: "logical-parent";
}

export interface ObservationSummary {
  nodeLifecycleCounts: Record<ObservationNodeLifecycleStatus, number>;
  unresolvedOperationCounts: Record<string, number>;
  stepStatusCounts: Record<ObservationStepStatus, number>;
  messageCounts: Record<ObservationMessageChannel, number>;
}

const TREE_STATUSES = [
  "initializing",
  "active",
  "completed",
  "failed",
  "blocked",
  "cancel_requested",
  "cancelling",
  "cancelled",
  "cancel_blocked",
  "cleaned",
] as const satisfies readonly ObservationTreeStatus[];

const NODE_LIFECYCLE_STATUSES = [
  "reserved",
  "worktree_ready",
  "agent_ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancel_requested",
  "interrupting",
  "terminating",
  "force_terminating",
  "cancelled",
  "cancel_blocked",
] as const satisfies readonly ObservationNodeLifecycleStatus[];

const STEP_STATUSES = ["reserved", "claimed", "completed", "failed", "cancelled"] as const satisfies readonly ObservationStepStatus[];
const MESSAGE_CHANNELS = ["inbox", "outbox", "public", "private"] as const satisfies readonly ObservationMessageChannel[];
const MESSAGE_SCOPES = ["parent", "children", "siblings"] as const satisfies readonly ObservationMessageScope[];
const PLACEMENTS = ["workspace", "tab"] as const satisfies readonly ObservationPlacement[];
const WORKSPACE_MODES = ["read-only", "read-write"] as const satisfies readonly ObservationWorkspaceMode[];
const OPERATION_KINDS = ["workspace_create", "spawn", "worktree_create", "tab_create", "agent_start", "prompt", "step", "merge", "cancel", "quiesce", "message"] as const;
const UNRESOLVED_OPERATION_STATUSES = ["reserved", "submitted", "delivery_unknown", "observed", "blocked"] as const;

const REQUIRED_TABLES: Record<string, readonly [string, string][]> = {
  manifests: [
    ["manifest_digest", "TEXT"],
    ["api_version", "TEXT"],
    ["resolved_json", "TEXT"],
    ["created_at", "INTEGER"],
  ],
  trees: [
    ["tree_id", "TEXT"],
    ["run_id", "TEXT"],
    ["repo_root", "TEXT"],
    ["repo_source_workspace_id", "TEXT"],
    ["herdr_socket_path", "TEXT"],
    ["herdr_version", "TEXT"],
    ["herdr_protocol", "INTEGER"],
    ["base_commit", "TEXT"],
    ["worktree_root", "TEXT"],
    ["root_task_contract", "TEXT"],
    ["root_spawn_policy", "TEXT"],
    ["manifest_digest", "TEXT"],
    ["root_role", "TEXT"],
    ["status", "TEXT"],
    ["generation", "INTEGER"],
    ["created_at", "INTEGER"],
    ["updated_at", "INTEGER"],
  ],
  nodes: [
    ["node_id", "TEXT"],
    ["tree_id", "TEXT"],
    ["parent_node_id", "TEXT"],
    ["name", "TEXT"],
    ["depth", "INTEGER"],
    ["placement", "TEXT"],
    ["spawn_policy", "TEXT"],
    ["branch", "TEXT"],
    ["base_commit", "TEXT"],
    ["worktree_path", "TEXT"],
    ["workspace_id", "TEXT"],
    ["tab_id", "TEXT"],
    ["pane_id", "TEXT"],
    ["agent_name", "TEXT"],
    ["agent_session", "TEXT"],
    ["terminal_id", "TEXT"],
    ["agent_instance_id", "TEXT"],
    ["lifecycle_status", "TEXT"],
    ["task_contract", "TEXT"],
    ["role_name", "TEXT"],
    ["role_digest", "TEXT"],
    ["parameters_json", "TEXT"],
    ["resolved_capabilities_json", "TEXT"],
    ["generation", "INTEGER"],
    ["created_at", "INTEGER"],
    ["updated_at", "INTEGER"],
  ],
  operations: [
    ["operation_id", "TEXT"],
    ["tree_id", "TEXT"],
    ["node_id", "TEXT"],
    ["kind", "TEXT"],
    ["request_key", "TEXT"],
    ["request_hash", "TEXT"],
    ["status", "TEXT"],
    ["attempt", "INTEGER"],
    ["request_json", "TEXT"],
    ["result_json", "TEXT"],
    ["last_error", "TEXT"],
    ["created_at", "INTEGER"],
    ["updated_at", "INTEGER"],
  ],
  step_executions: [
    ["operation_id", "TEXT"],
    ["node_id", "TEXT"],
    ["run_number", "INTEGER"],
    ["iteration_number", "INTEGER"],
    ["step_number", "INTEGER"],
    ["prompt_sha256", "TEXT"],
    ["status", "TEXT"],
    ["claimed_by_agent_session", "TEXT"],
    ["claim_count", "INTEGER"],
    ["commit_sha", "TEXT"],
    ["result_message_id", "TEXT"],
    ["created_at", "INTEGER"],
    ["updated_at", "INTEGER"],
  ],
  messages: [
    ["message_id", "TEXT"],
    ["tree_id", "TEXT"],
    ["sender_node_id", "TEXT"],
    ["recipient_node_id", "TEXT"],
    ["channel", "TEXT"],
    ["kind", "TEXT"],
    ["priority", "INTEGER"],
    ["reply_to_message_id", "TEXT"],
    ["body", "TEXT"],
    ["created_at", "INTEGER"],
  ],
  receipts: [
    ["message_id", "TEXT"],
    ["reader_node_id", "TEXT"],
    ["read_at", "INTEGER"],
  ],
  cleanup_plans: [
    ["plan_digest", "TEXT"],
    ["tree_id", "TEXT"],
    ["tree_generation", "INTEGER"],
    ["manifest_digest", "TEXT"],
    ["plan_json", "TEXT"],
    ["status", "TEXT"],
    ["created_at", "INTEGER"],
    ["updated_at", "INTEGER"],
  ],
  cleanup_receipts: [
    ["plan_digest", "TEXT"],
    ["action_index", "INTEGER"],
    ["action_kind", "TEXT"],
    ["target", "TEXT"],
    ["outcome", "TEXT"],
    ["details_json", "TEXT"],
    ["completed_at", "INTEGER"],
  ],
};

interface TreeRow {
  treeId: unknown;
  runId: unknown;
  status: unknown;
  generation: unknown;
  manifestDigest: unknown;
  rootRole: unknown;
  baseCommit: unknown;
}


interface ManifestRow {
  digest: unknown;
  apiVersion: unknown;
  resolvedJson: unknown;
}


interface ParsedManifest {
  apiVersion: "sheltie.dev/v1alpha1";
  name: string;
  digest: string;
  root: {
    role: string;
    name: string;
  };
  limits: ObservationManifest["limits"];
  roles: Map<string, ObservationRole>;
}

function fail(message: string): never {
  throw new Error(`observation snapshot is unavailable: ${message}`);
}


function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} is malformed`);
  return value;
}

function requireField(record: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.hasOwn(record, key)) fail(`${label}.${key} is missing`);
  return record[key];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireString(value, label);
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer at least ${minimum}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function requireMember<T extends string>(value: unknown, members: readonly T[], label: string): T {
  if (typeof value !== "string" || !members.includes(value as T)) fail(`${label} is unsupported`);
  return value as T;
}

function requireStringArray<T extends string>(value: unknown, members: readonly T[], label: string): T[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => requireMember(entry, members, `${label}[${index}]`));
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an incompatible shape`);
  }
}

function assertKnownKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(record).some((key) => !keys.includes(key))) fail(`${label} has an incompatible shape`);
}

function requireName(value: unknown, label: string): string {
  const name = requireString(value, label);
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) fail(`${label} is invalid`);
  return name;
}

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

function countRows<T extends string>(rows: unknown[], members: readonly T[], label: string): Record<T, number> {
  const counts = emptyCounts(members);
  for (const rowValue of rows) {
    const row = requireRecord(rowValue, label);
    const key = requireMember(requireField(row, "key", label), members, `${label}.key`);
    if (counts[key] !== 0) fail(`${label} has duplicate aggregate rows`);
    counts[key] = requireInteger(requireField(row, "count", label), `${label}.count`);
  }
  return counts;
}
function countUnresolvedOperations(rows: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rowValue of rows) {
    const row = requireRecord(rowValue, "unresolved operation aggregate");
    const kind = requireMember(requireField(row, "kind", "unresolved operation aggregate"), OPERATION_KINDS, "unresolved operation kind");
    const status = requireMember(
      requireField(row, "status", "unresolved operation aggregate"),
      UNRESOLVED_OPERATION_STATUSES,
      "unresolved operation status",
    );
    const key = `${kind}:${status}`;
    if (Object.hasOwn(counts, key)) fail("unresolved operation aggregate has duplicate rows");
    counts[key] = requireInteger(requireField(row, "count", "unresolved operation aggregate"), "unresolved operation count");
  }
  return counts;
}

function parseManifest(resolvedJson: string, digest: string, apiVersion: string): ParsedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(resolvedJson) as unknown;
  } catch {
    fail("stored manifest JSON is invalid");
  }
  const manifest = requireRecord(raw, "stored manifest");
  assertExactKeys(manifest, ["apiVersion", "kind", "metadata", "spec"], "stored manifest");
  if (apiVersion !== "sheltie.dev/v1alpha1" || requireString(manifest.apiVersion, "stored manifest.apiVersion") !== apiVersion) {
    fail("stored manifest has an unsupported API version");
  }
  if (requireString(manifest.kind, "stored manifest.kind") !== "Run") fail("stored manifest has an unsupported kind");
  if (requestHash(manifest) !== digest) fail("stored manifest digest does not match its contents");

  const metadata = requireRecord(requireField(manifest, "metadata", "stored manifest"), "stored manifest.metadata");
  assertExactKeys(metadata, ["name"], "stored manifest.metadata");
  const name = requireName(requireField(metadata, "name", "stored manifest.metadata"), "stored manifest.metadata.name");

  const spec = requireRecord(requireField(manifest, "spec", "stored manifest"), "stored manifest.spec");
  assertExactKeys(spec, ["root", "limits", "roles"], "stored manifest.spec");
  const root = requireRecord(requireField(spec, "root", "stored manifest.spec"), "stored manifest.spec.root");
  assertExactKeys(root, ["role", "name"], "stored manifest.spec.root");
  const rootRole = requireName(requireField(root, "role", "stored manifest.spec.root"), "stored manifest.spec.root.role");
  const rootName = requireName(requireField(root, "name", "stored manifest.spec.root"), "stored manifest.spec.root.name");

  const limits = requireRecord(requireField(spec, "limits", "stored manifest.spec"), "stored manifest.spec.limits");
  assertExactKeys(limits, ["maxDepth", "maxChildrenPerNode", "maxDescendants", "maxParallelNodes"], "stored manifest.spec.limits");
  const parsedLimits = {
    maxDepth: requireInteger(requireField(limits, "maxDepth", "stored manifest.spec.limits"), "stored manifest.spec.limits.maxDepth", 1),
    maxChildrenPerNode: requireInteger(
      requireField(limits, "maxChildrenPerNode", "stored manifest.spec.limits"),
      "stored manifest.spec.limits.maxChildrenPerNode",
      1,
    ),
    maxDescendants: requireInteger(
      requireField(limits, "maxDescendants", "stored manifest.spec.limits"),
      "stored manifest.spec.limits.maxDescendants",
      1,
    ),
    maxParallelNodes: requireInteger(
      requireField(limits, "maxParallelNodes", "stored manifest.spec.limits"),
      "stored manifest.spec.limits.maxParallelNodes",
      1,
    ),
  };

  const rawRoles = requireRecord(requireField(spec, "roles", "stored manifest.spec"), "stored manifest.spec.roles");
  const roleNames = Object.keys(rawRoles).sort();
  if (roleNames.length === 0 || roleNames.length > 128) fail("stored manifest has an invalid role set");
  const roles = new Map<string, ObservationRole>();
  for (const roleName of roleNames) {
    const role = requireRecord(rawRoles[roleName], `stored manifest role`);
    assertExactKeys(
      role,
      ["name", "placement", "agent", "prompt", "parameters", "capabilities", "executionPolicy", "digest"],
      "stored manifest role",
    );
    if (requireName(requireField(role, "name", "stored manifest role"), "stored manifest role.name") !== roleName) {
      fail("stored manifest role name does not match its key");
    }
    const roleDigest = requireString(requireField(role, "digest", "stored manifest role"), "stored manifest role.digest");
    const { digest: ignoredDigest, ...roleContents } = role;
    if (requestHash(roleContents) !== roleDigest) fail("stored manifest role digest does not match its contents");
    void ignoredDigest;

    const agent = requireRecord(requireField(role, "agent", "stored manifest role"), "stored manifest role.agent");
    assertExactKeys(agent, ["kind", "args"], "stored manifest role.agent");
    requireName(requireField(agent, "kind", "stored manifest role.agent"), "stored manifest role.agent.kind");
    if (!Array.isArray(requireField(agent, "args", "stored manifest role.agent"))) {
      fail("stored manifest role.agent.args must be an array");
    }
    for (const argument of requireField(agent, "args", "stored manifest role.agent") as unknown[]) {
      requireString(argument, "stored manifest role.agent.args");
    }

    const prompt = requireRecord(requireField(role, "prompt", "stored manifest role"), "stored manifest role.prompt");
    assertExactKeys(prompt, ["content", "digest", "source"], "stored manifest role.prompt");
    const promptContent = requireString(requireField(prompt, "content", "stored manifest role.prompt"), "stored manifest role.prompt.content");
    if (requestHash(promptContent) !== requireString(requireField(prompt, "digest", "stored manifest role.prompt"), "stored manifest role.prompt.digest")) {
      fail("stored manifest role prompt digest does not match its contents");
    }
    requireString(requireField(prompt, "source", "stored manifest role.prompt"), "stored manifest role.prompt.source");

    const parameters = requireRecord(requireField(role, "parameters", "stored manifest role"), "stored manifest role.parameters");
    for (const definitionValue of Object.values(parameters)) {
      const definition = requireRecord(definitionValue, "stored manifest parameter");
      assertKnownKeys(definition, ["type", "required", "maxLength"], "stored manifest parameter");
      const type = requireMember(
        requireField(definition, "type", "stored manifest parameter"),
        ["string", "integer", "boolean"],
        "stored manifest parameter.type",
      );
      requireBoolean(requireField(definition, "required", "stored manifest parameter"), "stored manifest parameter.required");
      if (Object.hasOwn(definition, "maxLength")) {
        if (type !== "string") fail("stored manifest parameter.maxLength has an incompatible type");
        requireInteger(definition.maxLength, "stored manifest parameter.maxLength", 1);
      }
    }

    const capabilities = requireRecord(
      requireField(role, "capabilities", "stored manifest role"),
      "stored manifest role.capabilities",
    );
    assertExactKeys(capabilities, ["spawn", "mergeChildren", "messaging"], "stored manifest role.capabilities");
    const spawn = requireRecord(
      requireField(capabilities, "spawn", "stored manifest role.capabilities"),
      "stored manifest role.capabilities.spawn",
    );
    assertKnownKeys(spawn, ["roles", "maxChildren"], "stored manifest role.capabilities.spawn");
    const allowedChildRoles = requireStringArray(
      requireField(spawn, "roles", "stored manifest role.capabilities.spawn"),
      roleNames,
      "stored manifest role.capabilities.spawn.roles",
    );
    if (new Set(allowedChildRoles).size !== allowedChildRoles.length) {
      fail("stored manifest role.capabilities.spawn.roles contains duplicates");
    }
    if (Object.hasOwn(spawn, "maxChildren")) {
      requireInteger(spawn.maxChildren, "stored manifest role.capabilities.spawn.maxChildren", 1);
    }
    const messaging = requireRecord(
      requireField(capabilities, "messaging", "stored manifest role.capabilities"),
      "stored manifest role.capabilities.messaging",
    );
    assertExactKeys(messaging, ["sendTo", "receiveFrom"], "stored manifest role.capabilities.messaging");
    const sendTo = requireStringArray(
      requireField(messaging, "sendTo", "stored manifest role.capabilities.messaging"),
      MESSAGE_SCOPES,
      "stored manifest role.capabilities.messaging.sendTo",
    );
    const receiveFrom = requireStringArray(
      requireField(messaging, "receiveFrom", "stored manifest role.capabilities.messaging"),
      MESSAGE_SCOPES,
      "stored manifest role.capabilities.messaging.receiveFrom",
    );

    const executionPolicy = requireRecord(
      requireField(role, "executionPolicy", "stored manifest role"),
      "stored manifest role.executionPolicy",
    );
    assertExactKeys(executionPolicy, ["workspace"], "stored manifest role.executionPolicy");
    const workspaceMode = requireMember(
      requireField(executionPolicy, "workspace", "stored manifest role.executionPolicy"),
      WORKSPACE_MODES,
      "stored manifest role.executionPolicy.workspace",
    );
    const placement = requireMember(requireField(role, "placement", "stored manifest role"), PLACEMENTS, "stored manifest role.placement");
    roles.set(roleName, {
      name: roleName,
      digest: roleDigest,
      placement,
      allowedChildRoles: [...allowedChildRoles].sort(),
      mergeChildren: requireBoolean(
        requireField(capabilities, "mergeChildren", "stored manifest role.capabilities"),
        "stored manifest role.capabilities.mergeChildren",
      ),
      messaging: {
        sendTo: [...sendTo].sort(),
        receiveFrom: [...receiveFrom].sort(),
      },
      workspaceMode,
    });
  }
  const rootRoleDefinition = roles.get(rootRole);
  if (rootRoleDefinition === undefined || rootRoleDefinition.placement !== "workspace") {
    fail("stored manifest root role is invalid");
  }
  return {
    apiVersion: "sheltie.dev/v1alpha1",
    name,
    digest,
    root: { role: rootRole, name: rootName },
    limits: parsedLimits,
    roles,
  };
}

function validateSchema(database: Database): void {
  const integrityRows = database.query("PRAGMA integrity_check").all() as { integrity_check: unknown }[];
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") fail("SQLite integrity check failed");
  if (database.query("PRAGMA foreign_key_check").all().length !== 0) fail("SQLite foreign key check failed");

  const tableNames = Object.keys(REQUIRED_TABLES);
  const placeholders = tableNames.map(() => "?").join(", ");
  const schemaRows = database
    .query(`SELECT name, type, sql FROM sqlite_schema WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...tableNames) as { name: unknown; type: unknown; sql: unknown }[];
  const schemas = new Map<string, { type: unknown; sql: unknown }>();
  for (const row of schemaRows) schemas.set(requireString(row.name, "SQLite schema name"), { type: row.type, sql: row.sql });

  for (const [table, expectedColumns] of Object.entries(REQUIRED_TABLES)) {
    const schema = schemas.get(table);
    if (schema === undefined || schema.type !== "table" || typeof schema.sql !== "string" || !/\bSTRICT\b/i.test(schema.sql)) {
      fail(`SQLite schema is incompatible at table ${table}`);
    }
    const columnRows = database.query(`PRAGMA table_info('${table}')`).all() as { name: unknown; type: unknown }[];
    const columns = new Map<string, string>();
    for (const column of columnRows) {
      columns.set(requireString(column.name, `SQLite schema ${table} column`), requireString(column.type, `SQLite schema ${table} column type`).toUpperCase());
    }
    for (const [column, type] of expectedColumns) {
      if (columns.get(column) !== type) fail(`SQLite schema is incompatible at ${table}.${column}`);
    }
  }
}

function projectNode(value: unknown): ObservationNode {
  const row = requireRecord(value, "stored node");
  return {
    nodeId: requireString(requireField(row, "nodeId", "stored node"), "stored node.nodeId"),
    name: requireName(requireField(row, "name", "stored node"), "stored node.name"),
    parentNodeId: requireNullableString(requireField(row, "parentNodeId", "stored node"), "stored node.parentNodeId"),
    depth: requireInteger(requireField(row, "depth", "stored node"), "stored node.depth"),
    placement: requireMember(requireField(row, "placement", "stored node"), PLACEMENTS, "stored node.placement"),
    lifecycleStatus: requireMember(
      requireField(row, "lifecycleStatus", "stored node"),
      NODE_LIFECYCLE_STATUSES,
      "stored node.lifecycleStatus",
    ),
    roleName: requireName(requireField(row, "roleName", "stored node"), "stored node.roleName"),
    roleDigest: requireString(requireField(row, "roleDigest", "stored node"), "stored node.roleDigest"),
    generation: requireInteger(requireField(row, "generation", "stored node"), "stored node.generation", 1),
  };
}

function validateNodeTree(nodes: ObservationNode[], manifest: ParsedManifest): ObservationEdge[] {
  if (nodes.length === 0) return [];
  const nodesById = new Map<string, ObservationNode>();
  for (const node of nodes) {
    if (nodesById.has(node.nodeId)) fail("stored nodes have duplicate identities");
    const role = manifest.roles.get(node.roleName);
    if (role === undefined || role.digest !== node.roleDigest || role.placement !== node.placement) {
      fail("stored node has an invalid manifest role identity");
    }
    nodesById.set(node.nodeId, node);
  }

  const roots = nodes.filter((node) => node.parentNodeId === null);
  if (roots.length !== 1) fail("stored nodes must have exactly one root");
  const root = roots[0]!;
  if (root.depth !== 0 || root.roleName !== manifest.root.role || root.name !== manifest.root.name) {
    fail("stored root node does not match the manifest");
  }

  const edges: ObservationEdge[] = [];
  for (const node of nodes) {
    if (node.parentNodeId === null) continue;
    const parent = nodesById.get(node.parentNodeId);
    if (parent === undefined || node.depth !== parent.depth + 1) fail("stored node parent/depth integrity check failed");
    const parentRole = manifest.roles.get(parent.roleName);
    if (parentRole === undefined || !parentRole.allowedChildRoles.includes(node.roleName)) {
      fail("stored node parent role does not allow its child role");
    }
    edges.push({ fromNodeId: node.parentNodeId, toNodeId: node.nodeId, kind: "logical-parent" });
  }
  return edges;
}

/**
 * Reads one immutable, product-safe observation snapshot from a Sheltie state directory.
 *
 * The reader never creates, migrates, or writes the state database. The optional clock
 * exists only to make callers that need reproducible snapshots able to supply one.
 */
export class ObservationReader {
  constructor(
    readonly stateDirectory: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  snapshot(): ObservationSnapshot {
    if (!existsSync(this.stateDirectory) || !statSync(this.stateDirectory).isDirectory()) {
      fail("state directory is missing");
    }
    const databasePath = join(this.stateDirectory, "state.sqlite");
    if (!existsSync(databasePath) || !statSync(databasePath).isFile()) fail("state database is missing");

    const database = new Database(databasePath, { readonly: true, strict: true });
    let transactionOpen = false;
    try {
      database.exec("PRAGMA query_only = 1");
      database.exec("BEGIN DEFERRED");
      transactionOpen = true;
      validateSchema(database);

      const treeRows = database
        .query(`SELECT tree_id AS treeId, run_id AS runId, status, generation,
          manifest_digest AS manifestDigest, root_role AS rootRole, base_commit AS baseCommit
          FROM trees ORDER BY created_at, tree_id`)
        .all() as TreeRow[];
      if (treeRows.length !== 1) fail("state database must contain exactly one tree");
      const tree = treeRows[0]!;
      const treeId = requireString(tree.treeId, "stored tree.id");
      const runId = requireString(tree.runId, "stored tree.runId");
      const status = requireMember(tree.status, TREE_STATUSES, "stored tree.status");
      const generation = requireInteger(tree.generation, "stored tree.generation", 1);
      const manifestDigest = requireString(tree.manifestDigest, "stored tree.manifestDigest");
      const rootRole = requireName(tree.rootRole, "stored tree.rootRole");
      const baseCommit = requireString(tree.baseCommit, "stored tree.baseCommit");

      const manifestRow = database
        .query(`SELECT manifest_digest AS digest, api_version AS apiVersion, resolved_json AS resolvedJson
          FROM manifests WHERE manifest_digest = ?`)
        .get(manifestDigest) as ManifestRow | null;
      if (manifestRow === null) fail("stored tree manifest is missing");
      const manifestRowDigest = requireString(manifestRow.digest, "stored manifest.digest");
      if (manifestRowDigest !== manifestDigest) fail("stored tree manifest identity does not match");
      const manifest = parseManifest(
        requireString(manifestRow.resolvedJson, "stored manifest JSON"),
        manifestDigest,
        requireString(manifestRow.apiVersion, "stored manifest API version"),
      );
      if (manifest.root.role !== rootRole) fail("stored tree root role does not match its manifest");

      const nodes = database
        .query(`SELECT node_id AS nodeId, name, parent_node_id AS parentNodeId, depth, placement,
          lifecycle_status AS lifecycleStatus, role_name AS roleName, role_digest AS roleDigest, generation
          FROM nodes WHERE tree_id = ? ORDER BY depth, node_id`)
        .all(treeId)
        .map(projectNode);
      if (nodes.length === 0 && status !== "initializing") fail("non-initializing tree has no root node");
      const edges = validateNodeTree(nodes, manifest);
      const nodeLifecycleCounts = emptyCounts(NODE_LIFECYCLE_STATUSES);
      for (const node of nodes) nodeLifecycleCounts[node.lifecycleStatus] += 1;

      const unresolvedOperationCounts = countUnresolvedOperations(
        database
          .query(`SELECT kind, status, COUNT(*) AS count FROM operations
            WHERE tree_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
            GROUP BY kind, status`)
          .all(treeId),
      );
      const stepStatusCounts = countRows<ObservationStepStatus>(
        database
          .query(`SELECT steps.status AS key, COUNT(*) AS count FROM step_executions AS steps
            JOIN nodes ON nodes.node_id = steps.node_id
            WHERE nodes.tree_id = ? GROUP BY steps.status`)
          .all(treeId),
        STEP_STATUSES,
        "step aggregate",
      );
      const messageCounts = countRows<ObservationMessageChannel>(
        database
          .query(`SELECT channel AS key, COUNT(*) AS count FROM messages
            WHERE tree_id = ? GROUP BY channel`)
          .all(treeId),
        MESSAGE_CHANNELS,
        "message aggregate",
      );

      return {
        apiVersion: OBSERVATION_API_VERSION,
        kind: OBSERVATION_KIND,
        observedAt: this.clock().toISOString(),
        run: { treeId, runId, status, generation, manifestDigest, rootRole, baseCommit },
        manifest: {
          apiVersion: manifest.apiVersion,
          name: manifest.name,
          digest: manifest.digest,
          root: manifest.root,
          limits: manifest.limits,
          roles: [...manifest.roles.values()],
        },
        nodes,
        edges,
        summary: { nodeLifecycleCounts, unresolvedOperationCounts, stepStatusCounts, messageCounts },
      };
    } finally {
      try {
        if (transactionOpen) database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    }
  }
}
