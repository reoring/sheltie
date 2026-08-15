import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OperationConflictError, SheltieStore } from "../src/db.ts";
import { resolveManifestFile } from "../src/manifest.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): SheltieStore {
  const root = mkdtempSync(join(tmpdir(), "sheltie-db-test-"));
  roots.push(root);
  return new SheltieStore(join(root, "state.sqlite"));
}

function seedTree(store: SheltieStore): void {
  store.createTree({
    treeId: "tree-1",
    runId: "run-1",
    repoRoot: "/tmp/repo",
    repoSourceWorkspaceId: "w1",
    herdrSocketPath: "/tmp/herdr.sock",
    herdrVersion: "0.8.0",
    herdrProtocol: 19,
    baseCommit: "a".repeat(40),
    worktreeRoot: "/tmp/worktrees",
    rootTaskContract: "root task",
    status: "active",
  });
  store.reserveNode({
    nodeId: "node-root",
    treeId: "tree-1",
    parentNodeId: null,
    name: "root",
    depth: 0,
    branch: "sheltie/root",
    baseCommit: "a".repeat(40),
    worktreePath: "/tmp/worktrees/root",
    taskContract: "root task",
  });
}

describe("operation ledger", () => {
  test("returns the original operation for an identical request and rejects drift", () => {
    const store = createStore();
    seedTree(store);

    const first = store.reserveOperation({
      operationId: "op-1",
      treeId: "tree-1",
      nodeId: "node-root",
      kind: "spawn",
      requestKey: "root/spawn/child",
      requestHash: "hash-a",
      request: { name: "child" },
    });
    const replay = store.reserveOperation({
      operationId: "different-client-id",
      treeId: "tree-1",
      nodeId: "node-root",
      kind: "spawn",
      requestKey: "root/spawn/child",
      requestHash: "hash-a",
      request: { name: "child" },
    });

    expect(replay.operationId).toBe(first.operationId);
    expect(() =>
      store.reserveOperation({
        operationId: "op-2",
        treeId: "tree-1",
        nodeId: "node-root",
        kind: "spawn",
        requestKey: "root/spawn/child",
        requestHash: "hash-b",
        request: { name: "different" },
      }),
    ).toThrow(OperationConflictError);
    store.close();
  });
});

describe("step execution claim", () => {
  test("allows one agent session to claim work and turns completed replays into no-ops", () => {
    const store = createStore();
    seedTree(store);
    store.reserveStep({
      operationId: "step-1",
      nodeId: "node-root",
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256: "b".repeat(64),
    });

    expect(store.claimStep("step-1", "session-a")).toEqual({ outcome: "claimed" });
    expect(store.claimStep("step-1", "session-a")).toEqual({ outcome: "already_claimed" });
    expect(store.claimStep("step-1", "session-b")).toEqual({ outcome: "conflict" });

    store.completeStep({
      operationId: "step-1",
      agentSession: "session-a",
      commitSha: "c".repeat(40),
      resultMessageId: null,
    });
    expect(store.claimStep("step-1", "session-a")).toEqual({
      outcome: "completed",
      commitSha: "c".repeat(40),
    });
    expect(store.getStep("step-1").claimCount).toBe(1);
    store.close();
  });
});

describe("recursive spawn limits", () => {
  test("checks depth and direct-child capacity inside the reservation transaction", () => {
    const store = createStore();
    seedTree(store);
    const childInput = {
      nodeId: "node-child",
      treeId: "tree-1",
      parentNodeId: "node-root",
      name: "child",
      depth: 1,
      branch: "sheltie/root.child",
      baseCommit: "a".repeat(40),
      worktreePath: "/tmp/worktrees/child",
      taskContract: "child task",
    };

    store.reserveChildNode(childInput, { maxDepth: 2, maxChildren: 1, maxDescendants: 2 });

    expect(() =>
      store.reserveChildNode(
        {
          ...childInput,
          nodeId: "node-other",
          name: "other",
          branch: "sheltie/root.other",
          worktreePath: "/tmp/worktrees/other",
        },
        { maxDepth: 2, maxChildren: 1, maxDescendants: 2 },
      ),
    ).toThrow("max children");
    expect(() =>
      store.reserveChildNode(
        {
          ...childInput,
          nodeId: "node-too-deep",
          parentNodeId: "node-child",
          name: "too-deep",
          depth: 2,
          branch: "sheltie/root.child.too-deep",
          worktreePath: "/tmp/worktrees/too-deep",
        },
        { maxDepth: 1, maxChildren: 2, maxDescendants: 2 },
      ),
    ).toThrow("max depth");
    store.close();
  });
});

describe("durable inbox", () => {
  test("records read receipts in the same sync operation", () => {
    const store = createStore();
    seedTree(store);
    store.reserveNode({
      nodeId: "node-child",
      treeId: "tree-1",
      parentNodeId: "node-root",
      name: "child",
      depth: 1,
      branch: "sheltie/root.child",
      baseCommit: "a".repeat(40),
      worktreePath: "/tmp/worktrees/child",
      taskContract: "child task",
    });
    store.sendMessage({
      messageId: "message-1",
      treeId: "tree-1",
      senderNodeId: "node-child",
      recipientNodeId: "node-root",
      channel: "inbox",
      kind: "progress",
      priority: 4,
      replyToMessageId: null,
      body: "child update",
    });

    const first = store.syncInbox("node-root");
    const second = store.syncInbox("node-root");

    expect(first.map((message) => message.messageId)).toEqual(["message-1"]);
    expect(first.map((message) => message.kind)).toEqual(["progress"]);
    expect(second).toEqual([]);
    expect(store.hasReadReceipt("message-1", "node-root")).toBe(true);
    store.close();
  });
});

describe("message completion lifecycle", () => {
  test("rejects results before finish, round-trips both kinds, and keeps inbox sync idempotent", () => {
    const store = createStore();
    seedTree(store);
    store.reserveNode({
      nodeId: "node-child",
      treeId: "tree-1",
      parentNodeId: "node-root",
      name: "child",
      depth: 1,
      branch: "sheltie/root.child",
      baseCommit: "a".repeat(40),
      worktreePath: "/tmp/worktrees/child",
      taskContract: "child task",
    });
    store.bindWorktree("node-child", { workspaceId: "w-child", tabId: "w-child:t1", paneId: "w-child:p1" });
    store.setNodeLifecycle("node-child", "running");

    expect(
      store.sendMessage({
        messageId: "message-progress",
        treeId: "tree-1",
        senderNodeId: "node-child",
        recipientNodeId: "node-root",
        channel: "inbox",
        kind: "progress",
        priority: 4,
        replyToMessageId: null,
        body: "still working",
      }),
    ).toMatchObject({ kind: "progress" });
    expect(() =>
      store.sendMessage({
        messageId: "message-result-before-finish",
        treeId: "tree-1",
        senderNodeId: "node-child",
        recipientNodeId: "node-root",
        channel: "inbox",
        kind: "result",
        priority: 5,
        replyToMessageId: null,
        body: "done",
      }),
    ).toThrow("result message sender node-child is not completed");
    expect(store.listMessages("tree-1").map((message) => message.messageId)).toEqual(["message-progress"]);

    store.reserveStep({
      operationId: "step-child",
      nodeId: "node-child",
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256: "b".repeat(64),
    });
    store.claimStep("step-child", "w-child:p1");
    store.completeStep({
      operationId: "step-child",
      agentSession: "w-child:p1",
      commitSha: "c".repeat(40),
      resultMessageId: null,
    });
    expect(store.finishNode("node-child", "w-child:p1").lifecycleStatus).toBe("completed");
    expect(
      store.sendMessage({
        messageId: "message-result",
        treeId: "tree-1",
        senderNodeId: "node-child",
        recipientNodeId: "node-root",
        channel: "inbox",
        kind: "result",
        priority: 5,
        replyToMessageId: null,
        body: "done",
      }),
    ).toMatchObject({ kind: "result" });

    expect(store.syncInbox("node-root").map((message) => message.kind)).toEqual(["result", "progress"]);
    expect(store.syncInbox("node-root")).toEqual([]);
    store.close();
  });
});

describe("real run lifecycle", () => {
  test("persists an initializing tree before binding its source workspace", () => {
    const store = createStore();
    store.createTree({
      treeId: "tree-run",
      runId: "run-real",
      repoRoot: "/tmp/repo",
      repoSourceWorkspaceId: null,
      herdrSocketPath: "/tmp/herdr.sock",
      herdrVersion: "0.8.0",
      herdrProtocol: 20,
      baseCommit: "a".repeat(40),
      worktreeRoot: "/tmp/worktrees/run-real",
      rootTaskContract: "complete the real run",
      status: "initializing",
    });

    expect(store.getOnlyTree()).toMatchObject({
      treeId: "tree-run",
      repoSourceWorkspaceId: null,
      status: "initializing",
    });
    expect(store.bindRepoSourceWorkspace("tree-run", "w-source")).toMatchObject({
      repoSourceWorkspaceId: "w-source",
    });
    expect(store.setTreeStatus("tree-run", "active").status).toBe("active");
    store.close();
  });

  test("migrates pre-placement run state and permits tab nodes to share workspace paths", () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-db-migration-"));
    roots.push(root);
    const databasePath = join(root, "state.sqlite");
    const legacy = new Database(databasePath, { create: true, strict: true });
    legacy.exec(`CREATE TABLE trees (
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
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
    legacy
      .query(`INSERT INTO trees (
        tree_id, run_id, repo_root, repo_source_workspace_id, herdr_socket_path,
        herdr_version, herdr_protocol, base_commit, worktree_root, root_task_contract,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "tree-legacy",
        "run-legacy",
        "/tmp/repo",
        "w-source",
        "/tmp/herdr.sock",
        "0.8.0",
        20,
        "a".repeat(40),
        "/tmp/worktrees",
        "legacy task",
        "completed",
        1,
        1,
      );
    legacy.exec(`CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
      parent_node_id TEXT REFERENCES nodes(node_id),
      name TEXT NOT NULL,
      depth INTEGER NOT NULL,
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
      lifecycle_status TEXT NOT NULL,
      task_contract TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tree_id, parent_node_id, name),
      UNIQUE(tree_id, branch),
      UNIQUE(tree_id, worktree_path)
    ) STRICT;
    INSERT INTO nodes (
      node_id, tree_id, parent_node_id, name, depth, branch, base_commit, worktree_path,
      lifecycle_status, task_contract, generation, created_at, updated_at
    ) VALUES (
      'node-legacy', 'tree-legacy', NULL, 'root', 0, 'sheltie/root',
      '${"a".repeat(40)}', '/tmp/worktrees/root', 'completed', 'legacy task', 1, 1, 1
    )`);
    legacy.close();

    const migrated = new SheltieStore(databasePath);

    expect(migrated.getOnlyTree().generation).toBe(1);
    expect(migrated.getNode("node-legacy").placement).toBe("workspace");
    migrated.setTreeStatus("tree-legacy", "active");
    const tab = migrated.reserveChildNode(
      {
        nodeId: "node-tab",
        treeId: "tree-legacy",
        parentNodeId: "node-legacy",
        name: "reviewer",
        depth: 1,
        placement: "tab",
        branch: "sheltie/root",
        baseCommit: "a".repeat(40),
        worktreePath: "/tmp/worktrees/root",
        taskContract: "review",
      },
      { maxDepth: 2, maxChildren: 5, maxDescendants: 10 },
    );
    expect(tab).toMatchObject({ placement: "tab", branch: "sheltie/root", worktreePath: "/tmp/worktrees/root" });
    migrated.close();
  });

  test("migrates existing messages to checked progress kinds", () => {
    const store = createStore();
    seedTree(store);
    const databasePath = store.path;
    store.close();

    const legacy = new Database(databasePath, { strict: true });
    legacy.exec(`PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE messages_v2 (
        message_id TEXT PRIMARY KEY,
        tree_id TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
        sender_node_id TEXT NOT NULL REFERENCES nodes(node_id),
        recipient_node_id TEXT NOT NULL REFERENCES nodes(node_id),
        channel TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 10),
        reply_to_message_id TEXT REFERENCES messages_v2(message_id),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      DROP TABLE messages;
      ALTER TABLE messages_v2 RENAME TO messages;
      COMMIT;
      PRAGMA foreign_keys = ON;`);
    legacy
      .query(`INSERT INTO messages (
        message_id, tree_id, sender_node_id, recipient_node_id, channel, priority,
        reply_to_message_id, body, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("message-legacy", "tree-1", "node-root", "node-root", "inbox", 4, null, "legacy", 1);
    legacy.close();

    const migrated = new SheltieStore(databasePath);
    expect(migrated.listMessages("tree-1")).toEqual([
      expect.objectContaining({ messageId: "message-legacy", kind: "progress" }),
    ]);
    migrated.close();

    const checked = new Database(databasePath, { strict: true });
    try {
      expect(() => checked.query("UPDATE messages SET kind = 'completion'").run()).toThrow();
    } finally {
      checked.close();
    }
  });

  test("finishes a node only after its steps and direct children complete", () => {
    const store = createStore();
    seedTree(store);
    store.bindWorktree("node-root", { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1" });
    store.reserveStep({
      operationId: "step-root",
      nodeId: "node-root",
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256: "b".repeat(64),
    });
    store.claimStep("step-root", "w2:p1");

    expect(() => store.finishNode("node-root", "w2:p1")).toThrow("unfinished steps");
    store.completeStep({
      operationId: "step-root",
      agentSession: "w2:p1",
      commitSha: "c".repeat(40),
      resultMessageId: null,
    });
    store.reserveNode({
      nodeId: "node-child",
      treeId: "tree-1",
      parentNodeId: "node-root",
      name: "child",
      depth: 1,
      branch: "sheltie/root.child",
      baseCommit: "c".repeat(40),
      worktreePath: "/tmp/worktrees/child",
      taskContract: "child task",
    });

    expect(() => store.finishNode("node-root", "w2:p1")).toThrow("unfinished children");
    store.bindWorktree("node-child", { workspaceId: "w3", tabId: "w3:t1", paneId: "w3:p1" });
    store.reserveStep({
      operationId: "step-child",
      nodeId: "node-child",
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256: "d".repeat(64),
    });
    store.claimStep("step-child", "w3:p1");
    store.completeStep({
      operationId: "step-child",
      agentSession: "w3:p1",
      commitSha: "e".repeat(40),
      resultMessageId: null,
    });

    expect(store.finishNode("node-child", "w3:p1").lifecycleStatus).toBe("completed");
    expect(() => store.finishNode("node-root", "w2:p1")).toThrow("unmerged children");
    store.reserveOperation({
      operationId: "merge-child",
      treeId: "tree-1",
      nodeId: "node-root",
      kind: "merge",
      requestKey: "node-child",
      requestHash: "merge-request",
      request: { childNodeId: "node-child", childCommitSha: "e".repeat(40) },
    });
    store.setOperationStatus("merge-child", "completed", {
      result: { childNodeId: "node-child", childCommitSha: "e".repeat(40) },
    });
    expect(store.finishNode("node-root", "w2:p1").lifecycleStatus).toBe("completed");
    expect(store.finishNode("node-root", "w2:p1").lifecycleStatus).toBe("completed");
    store.close();
  });

  test("retries a short cross-process SQLite writer lock before failing the run", async () => {
    const store = createStore();
    seedTree(store);
    const databasePath = store.path;
    store.close();
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Database } from "bun:sqlite";
const db = new Database(process.env.DB_PATH, { strict: true });
db.exec("BEGIN IMMEDIATE");
console.log("locked");
// A real delay is required because the contending SQLite call blocks this process synchronously.
await Bun.sleep(400);
db.exec("COMMIT");
db.close();`,
      ],
      {
        env: { ...process.env, DB_PATH: databasePath },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = holder.stdout.getReader();
    const firstOutput = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(firstOutput.value)).toContain("locked");

    const contended = new SheltieStore(databasePath);
    expect(contended.setTreeStatus("tree-1", "active").status).toBe("active");
    contended.close();
    expect(await holder.exited).toBe(0);
  });
});

describe("manifest persistence", () => {
  test("binds one resolved manifest and role identity to the tree and nodes", () => {
    const store = createStore();
    const digest = "f".repeat(64);
    const resolved = { apiVersion: "sheltie.dev/v1alpha1", kind: "Run", spec: { roles: {} } };

    const tree = store.createManifestTree(
      {
        manifestDigest: digest,
        apiVersion: "sheltie.dev/v1alpha1",
        resolved,
      },
      {
        treeId: "tree-manifest",
        runId: "run-manifest",
        repoRoot: "/tmp/repo",
        repoSourceWorkspaceId: null,
        herdrSocketPath: "/tmp/herdr.sock",
        herdrVersion: "0.8.0",
        herdrProtocol: 20,
        baseCommit: "a".repeat(40),
        worktreeRoot: "/tmp/worktrees",
        rootTaskContract: "root role prompt",
        manifestDigest: digest,
        rootRole: "coordinator",
        status: "initializing",
      },
    );
    expect(tree).toMatchObject({ manifestDigest: digest, rootRole: "coordinator" });
    store.reserveNode({
      nodeId: "node-manifest-root",
      treeId: "tree-manifest",
      parentNodeId: null,
      name: "root",
      depth: 0,
      placement: "workspace",
      spawnPolicy: "workspace",
      branch: "sheltie/root",
      baseCommit: "a".repeat(40),
      worktreePath: "/tmp/repo",
      taskContract: "root role prompt",
      roleName: "coordinator",
      roleDigest: "e".repeat(64),
      parameters: { topic: "manifest" },
      resolvedCapabilities: { spawn: { roles: ["team"] } },
    });

    expect(store.getManifest(digest)).toEqual({
      manifestDigest: digest,
      apiVersion: "sheltie.dev/v1alpha1",
      resolved,
    });
    expect(store.getTree("tree-manifest")).toMatchObject({
      manifestDigest: digest,
      rootRole: "coordinator",
    });
    expect(store.getNode("node-manifest-root")).toMatchObject({
      roleName: "coordinator",
      roleDigest: "e".repeat(64),
      parameters: { topic: "manifest" },
      resolvedCapabilities: { spawn: { roles: ["team"] } },
    });
    store.close();
  });
});

describe("manifest messaging capabilities", () => {
  test("allows declared parent messaging and rejects sibling messaging before insert", () => {
    const store = createStore();
    const manifestPath = join(dirname(store.path), "sheltie.yaml");
    writeFileSync(manifestPath, `apiVersion: sheltie.dev/v1alpha1
kind: Run
metadata:
  name: messaging-test
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
      prompt:
        inline: |
          coordinate children
      capabilities:
        spawn:
          roles: [worker]
        mergeChildren: true
        messaging:
          sendTo: [children]
          receiveFrom: [children]
    worker:
      placement: tab
      agent:
        kind: omp
      prompt:
        inline: |
          report to parent
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent]
`);
    const document = resolveManifestFile(manifestPath);
    store.saveManifest({
      manifestDigest: document.digest,
      apiVersion: document.manifest.apiVersion,
      resolved: document.manifest,
    });
    store.createTree({
      treeId: "tree-messaging",
      runId: "run-messaging",
      repoRoot: "/tmp/repo",
      repoSourceWorkspaceId: "w-root",
      herdrSocketPath: "/tmp/herdr.sock",
      herdrVersion: "0.8.0",
      herdrProtocol: 20,
      baseCommit: "a".repeat(40),
      worktreeRoot: "/tmp/worktrees",
      rootTaskContract: "coordinate children",
      manifestDigest: document.digest,
      rootRole: "coordinator",
      status: "active",
    });
    const coordinator = document.manifest.spec.roles.coordinator!;
    const worker = document.manifest.spec.roles.worker!;
    store.reserveNode({
      nodeId: "node-root",
      treeId: "tree-messaging",
      parentNodeId: null,
      name: "root",
      depth: 0,
      placement: "workspace",
      spawnPolicy: "tab",
      branch: "main",
      baseCommit: "a".repeat(40),
      worktreePath: "/tmp/repo",
      taskContract: coordinator.prompt.content,
      roleName: coordinator.name,
      roleDigest: coordinator.digest,
      parameters: {},
      resolvedCapabilities: coordinator.capabilities,
    });
    for (const name of ["worker-a", "worker-b"]) {
      store.reserveNode({
        nodeId: `node-${name}`,
        treeId: "tree-messaging",
        parentNodeId: "node-root",
        name,
        depth: 1,
        placement: "tab",
        spawnPolicy: "none",
        branch: "main",
        baseCommit: "a".repeat(40),
        worktreePath: "/tmp/repo",
        taskContract: worker.prompt.content,
        roleName: worker.name,
        roleDigest: worker.digest,
        parameters: {},
        resolvedCapabilities: worker.capabilities,
      });
    }

    expect(
      store.sendMessage({
        messageId: "message-parent",
        treeId: "tree-messaging",
        senderNodeId: "node-worker-a",
        recipientNodeId: "node-root",
        channel: "inbox",
        kind: "progress",
        priority: 4,
        replyToMessageId: null,
        body: "done",
      }).body,
    ).toBe("done");
    expect(() =>
      store.sendMessage({
        messageId: "message-sibling",
        treeId: "tree-messaging",
        senderNodeId: "node-worker-a",
        recipientNodeId: "node-worker-b",
        channel: "inbox",
        kind: "progress",
        priority: 4,
        replyToMessageId: null,
        body: "not allowed",
      }),
    ).toThrow("role worker cannot send messages to node node-worker-b");
    expect(store.listMessages("tree-messaging")).toHaveLength(1);
    store.close();
  });
});

describe("cleanup plan manifest identity", () => {
  test("keeps idempotent plans bound to matching tree and payload manifest identities", () => {
    const store = createStore();
    seedTree(store);
    const payload = { schemaVersion: 2, manifestDigest: null, actions: [] };
    const input = {
      planDigest: "c".repeat(64),
      treeId: "tree-1",
      treeGeneration: 1,
      manifestDigest: null,
      plan: payload,
    };

    const first = store.createCleanupPlan(input);
    expect(store.createCleanupPlan(input)).toEqual(first);

    const manifestDigest = "d".repeat(64);
    const database = new Database(store.path, { strict: true });
    try {
      database.query("UPDATE trees SET manifest_digest = ? WHERE tree_id = ?").run(manifestDigest, "tree-1");
    } finally {
      database.close();
    }

    expect(() =>
      store.createCleanupPlan({
        ...input,
        manifestDigest,
        plan: { ...payload, manifestDigest },
      }),
    ).toThrow("conflicts with its persisted receipt");
    expect(store.getCleanupPlan(input.planDigest)).toMatchObject({ manifestDigest: null, plan: payload });
    store.close();
  });

  test("backfills only the cleanup plan record manifest identity during migration", () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-cleanup-migration-"));
    roots.push(root);
    const path = join(root, "state.sqlite");
    const manifestDigest = "e".repeat(64);
    const legacyPlan = { schemaVersion: 1, actions: [] };
    const database = new Database(path, { create: true, strict: true });
    try {
      database.exec(`
        CREATE TABLE trees (
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
          root_spawn_policy TEXT NOT NULL DEFAULT 'none',
          manifest_digest TEXT,
          root_role TEXT,
          status TEXT NOT NULL DEFAULT 'initializing',
          generation INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE cleanup_plans (
          plan_digest TEXT PRIMARY KEY,
          tree_id TEXT NOT NULL REFERENCES trees(tree_id),
          tree_generation INTEGER NOT NULL,
          plan_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'applying',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      const insertTree = database.query(`INSERT INTO trees (
        tree_id, run_id, repo_root, repo_source_workspace_id, herdr_socket_path, herdr_version,
        herdr_protocol, base_commit, worktree_root, root_task_contract, root_spawn_policy,
        manifest_digest, root_role, status, generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insertTree.run(
        "tree-manifest",
        "run-manifest",
        "/tmp/repo",
        null,
        "/tmp/herdr.sock",
        "0.8.0",
        20,
        "a".repeat(40),
        "/tmp/worktrees",
        "root task",
        "none",
        manifestDigest,
        null,
        "completed",
        1,
        0,
        0,
      );
      insertTree.run(
        "tree-pre-manifest",
        "run-pre-manifest",
        "/tmp/repo",
        null,
        "/tmp/herdr.sock",
        "0.8.0",
        20,
        "b".repeat(40),
        "/tmp/worktrees",
        "root task",
        "none",
        null,
        null,
        "completed",
        1,
        0,
        0,
      );
      const insertPlan = database.query(`INSERT INTO cleanup_plans (
        plan_digest, tree_id, tree_generation, plan_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      insertPlan.run("f".repeat(64), "tree-manifest", 1, JSON.stringify(legacyPlan), "applying", 0, 0);
      insertPlan.run("0".repeat(64), "tree-pre-manifest", 1, JSON.stringify(legacyPlan), "applying", 0, 0);
    } finally {
      database.close();
    }

    const store = new SheltieStore(path);
    expect(store.getCleanupPlan("f".repeat(64))).toMatchObject({
      manifestDigest,
      plan: legacyPlan,
    });
    expect(store.getCleanupPlan("0".repeat(64))).toMatchObject({
      manifestDigest: null,
      plan: legacyPlan,
    });
    store.close();
  });
});
