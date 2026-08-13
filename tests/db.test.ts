import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationConflictError, SheltieStore } from "../src/db.ts";

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
      priority: 4,
      replyToMessageId: null,
      body: "child completed",
    });

    const first = store.syncInbox("node-root");
    const second = store.syncInbox("node-root");

    expect(first.map((message) => message.messageId)).toEqual(["message-1"]);
    expect(second).toEqual([]);
    expect(store.hasReadReceipt("message-1", "node-root")).toBe(true);
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
