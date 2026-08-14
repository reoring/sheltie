import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheltieStore } from "../src/db.ts";
import { resolveManifestFile } from "../src/manifest.ts";
import { OBSERVATION_API_VERSION, OBSERVATION_KIND, ObservationReader } from "../src/observation.ts";

const roots: string[] = [];
const FIXED_OBSERVED_AT = "2026-08-14T00:00:00.000Z";

const OBSERVATION_MANIFEST = `apiVersion: sheltie.dev/v1alpha1
kind: Run
metadata:
  name: observation-run
spec:
  root:
    role: coordinator
    name: root
  limits:
    maxDepth: 4
    maxChildrenPerNode: 8
    maxDescendants: 32
    maxParallelNodes: 8
  roles:
    coordinator:
      placement: workspace
      agent:
        kind: omp
        args: ["AGENT_ARGUMENT_MUST_NOT_LEAK"]
      prompt:
        inline: "PROMPT_BODY_MUST_NOT_LEAK"
      parameters:
        token:
          type: string
          required: false
      capabilities:
        spawn:
          roles: [worker]
        mergeChildren: true
        messaging:
          sendTo: [children]
          receiveFrom: [children]
      executionPolicy:
        workspace: read-write
    worker:
      placement: workspace
      agent:
        kind: omp
      prompt:
        inline: "worker prompt"
      capabilities:
        spawn:
          roles: [reviewer]
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent, children]
      executionPolicy:
        workspace: read-write
    reviewer:
      placement: tab
      agent:
        kind: omp
      prompt:
        inline: "reviewer prompt"
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent]
      executionPolicy:
        workspace: read-only
`;

interface Fixture {
  stateDirectory: string;
  statePath: string;
  manifestDigest: string;
  roleDigests: {
    coordinator: string;
    worker: string;
    reviewer: string;
  };
}

const DURABLE_TABLES = ["trees", "nodes", "operations", "step_executions", "messages", "receipts", "cleanup_plans", "cleanup_receipts"] as const;
type DurableTable = (typeof DURABLE_TABLES)[number];

function manifestRole(
  manifest: ReturnType<typeof resolveManifestFile>,
  name: "coordinator" | "worker" | "reviewer",
) {
  const role = manifest.manifest.spec.roles[name];
  if (role === undefined) throw new Error(`fixture role ${name} is missing`);
  return role;
}

function createFixture(): Fixture {
  const stateDirectory = mkdtempSync(join(tmpdir(), "sheltie-observation-"));
  roots.push(stateDirectory);
  const statePath = join(stateDirectory, "state.sqlite");
  const manifestPath = join(stateDirectory, "sheltie.yaml");
  writeFileSync(manifestPath, OBSERVATION_MANIFEST);
  const manifest = resolveManifestFile(manifestPath);
  const coordinator = manifestRole(manifest, "coordinator");
  const worker = manifestRole(manifest, "worker");
  const reviewer = manifestRole(manifest, "reviewer");
  const store = new SheltieStore(statePath);
  try {
    store.createManifestTree(
      {
        manifestDigest: manifest.digest,
        apiVersion: manifest.manifest.apiVersion,
        resolved: manifest.manifest,
      },
      {
        treeId: "tree-observation",
        runId: "run-observation",
        repoRoot: "/ABSOLUTE_PATH_MUST_NOT_LEAK/repository",
        repoSourceWorkspaceId: null,
        herdrSocketPath: "/HERDR_SOCKET_MUST_NOT_LEAK",
        herdrVersion: "0.8.0",
        herdrProtocol: 20,
        baseCommit: "a".repeat(40),
        worktreeRoot: "/ABSOLUTE_PATH_MUST_NOT_LEAK/worktrees",
        rootTaskContract: "TASK_CONTRACT_MUST_NOT_LEAK",
        rootSpawnPolicy: "workspace",
        manifestDigest: manifest.digest,
        rootRole: coordinator.name,
        status: "active",
      },
    );
    store.reserveNode({
      nodeId: "node-root",
      treeId: "tree-observation",
      parentNodeId: null,
      name: "root",
      depth: 0,
      placement: "workspace",
      spawnPolicy: "workspace",
      branch: "sheltie/root",
      baseCommit: "a".repeat(40),
      worktreePath: "/ABSOLUTE_PATH_MUST_NOT_LEAK/root",
      taskContract: "TASK_CONTRACT_MUST_NOT_LEAK",
      roleName: coordinator.name,
      roleDigest: coordinator.digest,
      parameters: { token: "PARAMETER_VALUE_MUST_NOT_LEAK" },
      resolvedCapabilities: coordinator.capabilities,
    });
    store.reserveNode({
      nodeId: "node-worker",
      treeId: "tree-observation",
      parentNodeId: "node-root",
      name: "worker",
      depth: 1,
      placement: "workspace",
      spawnPolicy: "tab",
      branch: "sheltie/root.worker",
      baseCommit: "a".repeat(40),
      worktreePath: "/ABSOLUTE_PATH_MUST_NOT_LEAK/worker",
      taskContract: "TASK_CONTRACT_MUST_NOT_LEAK",
      roleName: worker.name,
      roleDigest: worker.digest,
      parameters: { token: "CREDENTIAL_MUST_NOT_LEAK" },
      resolvedCapabilities: worker.capabilities,
    });
    store.reserveNode({
      nodeId: "node-reviewer",
      treeId: "tree-observation",
      parentNodeId: "node-worker",
      name: "reviewer",
      depth: 2,
      placement: "tab",
      spawnPolicy: "none",
      branch: "sheltie/root.worker.reviewer",
      baseCommit: "a".repeat(40),
      worktreePath: "/ABSOLUTE_PATH_MUST_NOT_LEAK/reviewer",
      taskContract: "TASK_CONTRACT_MUST_NOT_LEAK",
      roleName: reviewer.name,
      roleDigest: reviewer.digest,
      parameters: {},
      resolvedCapabilities: reviewer.capabilities,
    });
    store.bindWorktree("node-root", {
      workspaceId: "WORKSPACE_LOCATOR_MUST_NOT_LEAK",
      tabId: "TAB_LOCATOR_MUST_NOT_LEAK",
      paneId: "PANE_LOCATOR_MUST_NOT_LEAK",
    });
    store.bindAgent("node-root", {
      agentName: "AGENT_LOCATOR_MUST_NOT_LEAK",
      agentSession: "AGENT_SESSION_MUST_NOT_LEAK",
      terminalId: "TERMINAL_LOCATOR_MUST_NOT_LEAK",
      agentInstanceId: "AGENT_INSTANCE_MUST_NOT_LEAK",
    });
    store.bindWorktree("node-worker", {
      workspaceId: "WORKSPACE_LOCATOR_MUST_NOT_LEAK-worker",
      tabId: "TAB_LOCATOR_MUST_NOT_LEAK-worker",
      paneId: "PANE_LOCATOR_MUST_NOT_LEAK-worker",
    });
    store.reserveOperation({
      operationId: "RAW_OPERATION_ID_MUST_NOT_LEAK",
      treeId: "tree-observation",
      nodeId: "node-root",
      kind: "spawn",
      requestKey: "RAW_OPERATION_KEY_MUST_NOT_LEAK",
      requestHash: "RAW_OPERATION_HASH_MUST_NOT_LEAK",
      request: { payload: "RAW_OPERATION_PAYLOAD_MUST_NOT_LEAK" },
    });
    store.reserveOperation({
      operationId: "completed-operation",
      treeId: "tree-observation",
      nodeId: "node-worker",
      kind: "merge",
      requestKey: "completed-operation",
      requestHash: "completed-operation",
      request: { payload: "COMPLETED_OPERATION_PAYLOAD_MUST_NOT_LEAK" },
    });
    store.setOperationStatus("completed-operation", "completed", {
      result: { secret: "COMPLETED_OPERATION_RESULT_MUST_NOT_LEAK" },
      lastError: "COMPLETED_OPERATION_ERROR_MUST_NOT_LEAK",
    });
    store.reserveStep({
      operationId: "RAW_STEP_OPERATION_ID_MUST_NOT_LEAK",
      nodeId: "node-root",
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256: "PROMPT_SHA_MUST_NOT_LEAK",
    });
    store.reserveStep({
      operationId: "claimed-step-operation",
      nodeId: "node-worker",
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 2,
      promptSha256: "ANOTHER_PROMPT_SHA_MUST_NOT_LEAK",
    });
    store.claimStep("claimed-step-operation", "STEP_AGENT_SESSION_MUST_NOT_LEAK");
    store.sendMessage({
      messageId: "MESSAGE_ID_MUST_NOT_LEAK",
      treeId: "tree-observation",
      senderNodeId: "node-worker",
      recipientNodeId: "node-root",
      channel: "inbox",
      kind: "progress",
      priority: 5,
      replyToMessageId: null,
      body: "MESSAGE_BODY_MUST_NOT_LEAK",
    });
    store.syncInbox("node-root");
  } finally {
    store.close();
  }
  return {
    stateDirectory,
    statePath,
    manifestDigest: manifest.digest,
    roleDigests: {
      coordinator: coordinator.digest,
      worker: worker.digest,
      reviewer: reviewer.digest,
    },
  };
}

function durableState(path: string): {
  counts: Record<DurableTable, number>;
  tree: unknown[];
  nodes: unknown[];
  operations: unknown[];
  steps: unknown[];
  messages: unknown[];
  receipts: unknown[];
  cleanupPlans: unknown[];
  cleanupReceipts: unknown[];
} {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const counts = {} as Record<DurableTable, number>;
    for (const table of DURABLE_TABLES) {
      const row = database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      counts[table] = row.count;
    }
    return {
      counts,
      tree: database.query("SELECT tree_id AS treeId, status, generation, created_at AS createdAt, updated_at AS updatedAt FROM trees").all(),
      nodes: database.query("SELECT node_id AS nodeId, lifecycle_status AS lifecycleStatus, generation, created_at AS createdAt, updated_at AS updatedAt FROM nodes ORDER BY node_id").all(),
      operations: database.query("SELECT operation_id AS operationId, status, attempt, created_at AS createdAt, updated_at AS updatedAt FROM operations ORDER BY operation_id").all(),
      steps: database.query("SELECT operation_id AS operationId, status, claim_count AS claimCount, created_at AS createdAt, updated_at AS updatedAt FROM step_executions ORDER BY operation_id").all(),
      messages: database.query("SELECT message_id AS messageId, created_at AS createdAt FROM messages ORDER BY message_id").all(),
      receipts: database.query("SELECT message_id AS messageId, reader_node_id AS readerNodeId, read_at AS readAt FROM receipts ORDER BY message_id, reader_node_id").all(),
      cleanupPlans: database.query("SELECT plan_digest AS planDigest, status, created_at AS createdAt, updated_at AS updatedAt FROM cleanup_plans ORDER BY plan_digest").all(),
      cleanupReceipts: database.query("SELECT plan_digest AS planDigest, action_index AS actionIndex, completed_at AS completedAt FROM cleanup_receipts ORDER BY plan_digest, action_index").all(),
    };
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ObservationReader", () => {
  test("projects a manifest role graph separately from a root-to-workspace-to-tab runtime tree", () => {
    const fixture = createFixture();
    const snapshot = new ObservationReader(fixture.stateDirectory, () => new Date(FIXED_OBSERVED_AT)).snapshot();

    expect(snapshot.apiVersion).toBe(OBSERVATION_API_VERSION);
    expect(snapshot.kind).toBe(OBSERVATION_KIND);
    expect(snapshot.observedAt).toBe(FIXED_OBSERVED_AT);
    expect(snapshot.run).toEqual({
      treeId: "tree-observation",
      runId: "run-observation",
      status: "active",
      generation: 1,
      manifestDigest: fixture.manifestDigest,
      rootRole: "coordinator",
      baseCommit: "a".repeat(40),
    });
    expect(snapshot.manifest).toEqual({
      apiVersion: "sheltie.dev/v1alpha1",
      name: "observation-run",
      digest: fixture.manifestDigest,
      root: { role: "coordinator", name: "root" },
      limits: { maxDepth: 4, maxChildrenPerNode: 8, maxDescendants: 32, maxParallelNodes: 8 },
      roles: [
        {
          name: "coordinator",
          digest: fixture.roleDigests.coordinator,
          placement: "workspace",
          allowedChildRoles: ["worker"],
          mergeChildren: true,
          messaging: { sendTo: ["children"], receiveFrom: ["children"] },
          workspaceMode: "read-write",
        },
        {
          name: "reviewer",
          digest: fixture.roleDigests.reviewer,
          placement: "tab",
          allowedChildRoles: [],
          mergeChildren: false,
          messaging: { sendTo: ["parent"], receiveFrom: ["parent"] },
          workspaceMode: "read-only",
        },
        {
          name: "worker",
          digest: fixture.roleDigests.worker,
          placement: "workspace",
          allowedChildRoles: ["reviewer"],
          mergeChildren: false,
          messaging: { sendTo: ["parent"], receiveFrom: ["children", "parent"] },
          workspaceMode: "read-write",
        },
      ],
    });
    expect(snapshot.nodes).toEqual([
      {
        nodeId: "node-root",
        name: "root",
        parentNodeId: null,
        depth: 0,
        placement: "workspace",
        lifecycleStatus: "agent_ready",
        roleName: "coordinator",
        roleDigest: fixture.roleDigests.coordinator,
        generation: 1,
      },
      {
        nodeId: "node-worker",
        name: "worker",
        parentNodeId: "node-root",
        depth: 1,
        placement: "workspace",
        lifecycleStatus: "worktree_ready",
        roleName: "worker",
        roleDigest: fixture.roleDigests.worker,
        generation: 1,
      },
      {
        nodeId: "node-reviewer",
        name: "reviewer",
        parentNodeId: "node-worker",
        depth: 2,
        placement: "tab",
        lifecycleStatus: "reserved",
        roleName: "reviewer",
        roleDigest: fixture.roleDigests.reviewer,
        generation: 1,
      },
    ]);
    expect(snapshot.edges).toEqual([
      { fromNodeId: "node-root", toNodeId: "node-worker", kind: "logical-parent" },
      { fromNodeId: "node-worker", toNodeId: "node-reviewer", kind: "logical-parent" },
    ]);
    expect(snapshot.summary).toEqual({
      nodeLifecycleCounts: {
        reserved: 1,
        worktree_ready: 1,
        agent_ready: 1,
        running: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
        cancel_requested: 0,
        interrupting: 0,
        terminating: 0,
        force_terminating: 0,
        cancelled: 0,
        cancel_blocked: 0,
      },
      unresolvedOperationCounts: { "spawn:reserved": 1 },
      stepStatusCounts: { reserved: 1, claimed: 1, completed: 0, failed: 0, cancelled: 0 },
      messageCounts: { inbox: 1, outbox: 0, public: 0, private: 0 },
    });
  });

  test("does not create a missing database", () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "sheltie-observation-missing-"));
    roots.push(stateDirectory);

    expect(() => new ObservationReader(stateDirectory).snapshot()).toThrow("state database is missing");
    expect(existsSync(join(stateDirectory, "state.sqlite"))).toBe(false);
  });

  test("fails closed for an unsupported database schema", () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "sheltie-observation-schema-"));
    roots.push(stateDirectory);
    const statePath = join(stateDirectory, "state.sqlite");
    const database = new Database(statePath, { create: true, strict: true });
    try {
      database.exec("CREATE TABLE trees (tree_id TEXT PRIMARY KEY) STRICT");
    } finally {
      database.close();
    }

    expect(() => new ObservationReader(stateDirectory).snapshot()).toThrow("SQLite schema is incompatible");
    const schemaAfterRead = new Database(statePath, { readonly: true, strict: true });
    try {
      expect(schemaAfterRead.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()).toEqual([
        { name: "trees" },
      ]);
    } finally {
      schemaAfterRead.close();
    }
  });

  test("fails closed when cleanup plans omit manifest identity", () => {
    const fixture = createFixture();
    const database = new Database(fixture.statePath, { strict: true });
    try {
      database.exec("ALTER TABLE cleanup_plans DROP COLUMN manifest_digest");
    } finally {
      database.close();
    }

    expect(() => new ObservationReader(fixture.stateDirectory).snapshot()).toThrow("SQLite schema is incompatible");
  });

  test("fails closed for orphaned nodes and depth mismatches", () => {
    const orphanFixture = createFixture();
    const orphanDatabase = new Database(orphanFixture.statePath, { strict: true });
    orphanDatabase.exec("PRAGMA foreign_keys = OFF");
    try {
      orphanDatabase.query("UPDATE nodes SET parent_node_id = ? WHERE node_id = ?").run("node-missing", "node-worker");
    } finally {
      orphanDatabase.close();
    }
    expect(() => new ObservationReader(orphanFixture.stateDirectory).snapshot()).toThrow("foreign key check failed");

    const depthFixture = createFixture();
    const depthDatabase = new Database(depthFixture.statePath, { strict: true });
    try {
      depthDatabase.query("UPDATE nodes SET depth = ? WHERE node_id = ?").run(4, "node-worker");
    } finally {
      depthDatabase.close();
    }
    expect(() => new ObservationReader(depthFixture.stateDirectory).snapshot()).toThrow("parent/depth integrity check failed");
  });

  test("uses a write-impossible connection and leaves durable state and receipts unchanged", () => {
    const fixture = createFixture();
    const before = durableState(fixture.statePath);
    new ObservationReader(fixture.stateDirectory, () => new Date(FIXED_OBSERVED_AT)).snapshot();
    const after = durableState(fixture.statePath);

    expect(after).toEqual(before);
    const readonlyConnection = new Database(fixture.statePath, { readonly: true, strict: true });
    try {
      readonlyConnection.exec("PRAGMA query_only = 1");
      expect(() => readonlyConnection.exec("UPDATE trees SET status = 'failed'")).toThrow();
    } finally {
      readonlyConnection.close();
    }
  });

  test("never returns prompt, path, runtime locator, task, payload, parameter, or credential values", () => {
    const fixture = createFixture();
    const serialized = JSON.stringify(
      new ObservationReader(fixture.stateDirectory, () => new Date(FIXED_OBSERVED_AT)).snapshot(),
    );

    for (const forbidden of [
      "PROMPT_BODY_MUST_NOT_LEAK",
      "AGENT_ARGUMENT_MUST_NOT_LEAK",
      "ABSOLUTE_PATH_MUST_NOT_LEAK",
      "HERDR_SOCKET_MUST_NOT_LEAK",
      "TASK_CONTRACT_MUST_NOT_LEAK",
      "WORKSPACE_LOCATOR_MUST_NOT_LEAK",
      "TAB_LOCATOR_MUST_NOT_LEAK",
      "PANE_LOCATOR_MUST_NOT_LEAK",
      "AGENT_LOCATOR_MUST_NOT_LEAK",
      "AGENT_SESSION_MUST_NOT_LEAK",
      "TERMINAL_LOCATOR_MUST_NOT_LEAK",
      "AGENT_INSTANCE_MUST_NOT_LEAK",
      "RAW_OPERATION_ID_MUST_NOT_LEAK",
      "RAW_OPERATION_KEY_MUST_NOT_LEAK",
      "RAW_OPERATION_HASH_MUST_NOT_LEAK",
      "RAW_OPERATION_PAYLOAD_MUST_NOT_LEAK",
      "RAW_STEP_OPERATION_ID_MUST_NOT_LEAK",
      "PROMPT_SHA_MUST_NOT_LEAK",
      "MESSAGE_ID_MUST_NOT_LEAK",
      "MESSAGE_BODY_MUST_NOT_LEAK",
      "PARAMETER_VALUE_MUST_NOT_LEAK",
      "CREDENTIAL_MUST_NOT_LEAK",
      "COMPLETED_OPERATION_RESULT_MUST_NOT_LEAK",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
