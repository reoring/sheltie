import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { SheltieStore } from "./db.ts";
import { HerdrApiError, HerdrClient, type AgentInfo } from "./herdr-client.ts";
import { assertPrivateStateParentForDatabase } from "./state-security.ts";

const REQUIRED_IDENTITY_COLUMNS = {
  nodes: [
    ["node_id", "TEXT"],
    ["tree_id", "TEXT"],
    ["pane_id", "TEXT"],
    ["agent_name", "TEXT"],
    ["terminal_id", "TEXT"],
    ["agent_instance_id", "TEXT"],
  ],
  trees: [
    ["tree_id", "TEXT"],
    ["herdr_socket_path", "TEXT"],
    ["herdr_protocol", "INTEGER"],
    ["worktree_root", "TEXT"],
  ],
} as const;

export interface AgentCallerHerdrControl {
  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }>;
}

export interface AuthenticatedAgentCaller {
  node: {
    nodeId: string;
    treeId: string;
    paneId: string;
    agentName: string;
    terminalId: string;
    agentInstanceId: string;
  };
  tree: {
    treeId: string;
    herdrSocketPath: string;
    herdrProtocol: number;
    worktreeRoot: string;
  };
  callerPaneId: string;
}

interface IdentityRow {
  nodeId: unknown;
  nodeTreeId: unknown;
  paneId: unknown;
  agentName: unknown;
  terminalId: unknown;
  agentInstanceId: unknown;
  treeId: unknown;
  herdrSocketPath: unknown;
  herdrProtocol: unknown;
  worktreeRoot: unknown;
}

function fail(message: string): never {
  throw new Error(`caller authentication failed: ${message}`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function validateIdentitySchema(database: Database): void {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_IDENTITY_COLUMNS)) {
    const schema = database
      .query("SELECT type, sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table) as { type: unknown; sql: unknown } | null;
    if (schema === null || schema.type !== "table" || typeof schema.sql !== "string" || !/\bSTRICT\b/i.test(schema.sql)) {
      fail(`SQLite schema is incompatible at table ${table}`);
    }
    const columns = new Map(
      (database.query(`PRAGMA table_info('${table}')`).all() as { name: unknown; type: unknown }[]).map(
        (column) =>
          [
            requireNonEmptyString(column.name, `SQLite schema ${table} column`),
            requireNonEmptyString(column.type, `SQLite schema ${table} column type`).toUpperCase(),
          ] as const,
      ),
    );
    for (const [column, type] of requiredColumns) {
      if (columns.get(column) !== type) fail(`SQLite schema is incompatible at ${table}.${column}`);
    }
  }
}

function readStoredIdentity(input: {
  databasePath: string;
  callerPaneId: string;
  expectedNodeId?: string;
}): AuthenticatedAgentCaller {
  const databasePath = assertPrivateStateParentForDatabase(input.databasePath);
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    fail("state database is missing");
  }

  const database = new Database(databasePath, { readonly: true, strict: true });
  let transactionOpen = false;
  try {
    database.exec("PRAGMA query_only = 1");
    database.exec("BEGIN DEFERRED");
    transactionOpen = true;
    validateIdentitySchema(database);
    const rows = database
      .query(`SELECT node.node_id AS nodeId, node.tree_id AS nodeTreeId,
        node.pane_id AS paneId, node.agent_name AS agentName,
        node.terminal_id AS terminalId, node.agent_instance_id AS agentInstanceId,
        tree.tree_id AS treeId, tree.herdr_socket_path AS herdrSocketPath,
        tree.herdr_protocol AS herdrProtocol, tree.worktree_root AS worktreeRoot
        FROM nodes AS node JOIN trees AS tree ON tree.tree_id = node.tree_id
        WHERE node.pane_id = ?`)
      .all(input.callerPaneId) as IdentityRow[];
    if (rows.length !== 1) fail(`expected one node bound to pane ${input.callerPaneId}; found ${rows.length}`);
    const row = rows[0]!;
    const nodeId = requireNonEmptyString(row.nodeId, "stored node id");
    if (input.expectedNodeId !== undefined && nodeId !== input.expectedNodeId) {
      fail(`caller pane ${input.callerPaneId} is bound to node ${nodeId}, not expected node ${input.expectedNodeId}`);
    }
    const nodeTreeId = requireNonEmptyString(row.nodeTreeId, "stored node tree id");
    const treeId = requireNonEmptyString(row.treeId, "stored tree id");
    if (nodeTreeId !== treeId) fail(`stored node ${nodeId} has inconsistent tree identity`);
    if (row.herdrProtocol !== 20) fail(`stored tree ${treeId} does not use Herdr protocol 20`);

    const paneId = requireNonEmptyString(row.paneId, `node ${nodeId} pane identity`);
    const agentName = requireNonEmptyString(row.agentName, `node ${nodeId} Agent name`);
    const terminalId = requireNonEmptyString(row.terminalId, `node ${nodeId} terminal identity`);
    const agentInstanceId = requireNonEmptyString(row.agentInstanceId, `node ${nodeId} Agent instance identity`);
    return {
      node: { nodeId, treeId, paneId, agentName, terminalId, agentInstanceId },
      tree: {
        treeId,
        herdrSocketPath: requireNonEmptyString(row.herdrSocketPath, `tree ${treeId} Herdr socket path`),
        herdrProtocol: row.herdrProtocol,
        worktreeRoot: requireNonEmptyString(row.worktreeRoot, `tree ${treeId} worktree root`),
      },
      callerPaneId: input.callerPaneId,
    };
  } finally {
    try {
      if (transactionOpen) database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
}

export function assertAuthenticatedAgentCaller(
  store: SheltieStore,
  caller: AuthenticatedAgentCaller,
): void {
  const node = store.getNode(caller.node.nodeId);
  const tree = store.getTree(caller.tree.treeId);
  if (
    node.treeId !== caller.node.treeId ||
    node.paneId !== caller.node.paneId ||
    node.agentName !== caller.node.agentName ||
    node.terminalId !== caller.node.terminalId ||
    node.agentInstanceId !== caller.node.agentInstanceId ||
    tree.treeId !== caller.tree.treeId ||
    tree.herdrSocketPath !== caller.tree.herdrSocketPath ||
    tree.herdrProtocol !== caller.tree.herdrProtocol ||
    tree.worktreeRoot !== caller.tree.worktreeRoot
  ) {
    fail(`stored identity for caller node ${caller.node.nodeId} changed before mutation`);
  }
}

/**
 * Freshly binds one CLI caller pane to the protocol-20 Agent identity recorded for its node.
 *
 * State is read through a dedicated no-create, no-migrate SQLite connection that is
 * closed before Herdr is contacted. This is a runtime guard before durable writes,
 * not a hard sandbox boundary for the Unix user that owns the process and database.
 */
export class AgentCallerAuthenticator {
  constructor(
    private readonly createHerdrClient: (socketPath: string) => AgentCallerHerdrControl = (socketPath) =>
      new HerdrClient(socketPath),
  ) {}

  async authenticate(input: {
    databasePath: string;
    callerPaneId: string;
    expectedNodeId?: string;
  }): Promise<AuthenticatedAgentCaller> {
    const caller = readStoredIdentity(input);
    let current: AgentInfo;
    try {
      current = (await this.createHerdrClient(caller.tree.herdrSocketPath).agentGet(caller.node.agentName)).agent;
    } catch (error) {
      if (error instanceof HerdrApiError && ["agent_not_found", "agent_not_running"].includes(error.code)) {
        fail(`caller Agent ${caller.node.agentName} is not running (${error.code})`);
      }
      throw error;
    }

    if (current.launch_pending || !current.interactive_ready || current.agent_status === "done") {
      fail(`caller Agent ${caller.node.agentName} is not running`);
    }
    if (current.name !== caller.node.agentName) {
      fail(`caller Agent name drift: expected ${caller.node.agentName}, got ${current.name ?? "missing"}`);
    }
    if (current.pane_id !== caller.node.paneId || current.pane_id !== caller.callerPaneId) {
      fail(`caller Agent ${caller.node.agentName} pane drift: expected ${caller.node.paneId}, got ${current.pane_id}`);
    }
    if (current.terminal_id !== caller.node.terminalId) {
      fail(
        `caller Agent ${caller.node.agentName} terminal drift: expected ${caller.node.terminalId}, got ${current.terminal_id}`,
      );
    }
    if (typeof current.agent_instance_id !== "string" || current.agent_instance_id.length === 0) {
      fail(`caller Agent ${caller.node.agentName} has no per-launch instance identity`);
    }
    if (current.agent_instance_id !== caller.node.agentInstanceId) {
      fail(
        `caller Agent ${caller.node.agentName} instance drift: expected ${caller.node.agentInstanceId}, got ${current.agent_instance_id}`,
      );
    }

    return caller;
  }
}
