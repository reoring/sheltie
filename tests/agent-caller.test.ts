import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallerAuthenticator, type AgentCallerHerdrControl } from "../src/agent-caller.ts";
import { runCli } from "../src/cli.ts";
import { SheltieStore } from "../src/db.ts";
import { HerdrApiError, type AgentInfo } from "../src/herdr-client.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    terminal_id: "terminal-root",
    agent_instance_id: "instance-root",
    name: "agent-root",
    agent_status: "working",
    workspace_id: "workspace-root",
    tab_id: "workspace-root:tab-root",
    pane_id: "workspace-root:pane-root",
    launch_pending: false,
    interactive_ready: true,
    ...overrides,
  };
}

class FakeCallerHerdr implements AgentCallerHerdrControl {
  calls = 0;
  readonly targets: string[] = [];

  constructor(private readonly result: AgentInfo | Error) {}

  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    this.calls += 1;
    this.targets.push(target);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve({ type: "agent_info", agent: this.result });
  }
}

interface Fixture {
  store: SheltieStore;
  databasePath: string;
}

function createFixture(socketPath = "/unused/herdr.sock", bindAgent = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sheltie-agent-caller-"));
  roots.push(root);
  const databasePath = join(root, "state.sqlite");
  const store = new SheltieStore(databasePath);
  store.createTree({
    treeId: "tree-root",
    runId: "run-root",
    repoRoot: root,
    repoSourceWorkspaceId: null,
    herdrSocketPath: socketPath,
    herdrVersion: "0.8.0",
    herdrProtocol: 20,
    baseCommit: "a".repeat(40),
    worktreeRoot: join(root, "worktrees"),
    rootTaskContract: "complete the root task",
    status: "active",
  });
  store.reserveNode({
    nodeId: "node-root",
    treeId: "tree-root",
    parentNodeId: null,
    name: "root",
    depth: 0,
    branch: "sheltie/root",
    baseCommit: "a".repeat(40),
    worktreePath: root,
    taskContract: "complete the root task",
  });
  store.bindWorktree("node-root", {
    workspaceId: "workspace-root",
    tabId: "workspace-root:tab-root",
    paneId: "workspace-root:pane-root",
  });
  if (bindAgent) {
    store.bindAgent("node-root", {
      agentName: "agent-root",
      terminalId: "terminal-root",
      agentInstanceId: "instance-root",
    });
  }
  return { store, databasePath };
}

function seedChildAndStep(store: SheltieStore): void {
  store.reserveNode({
    nodeId: "node-child",
    treeId: "tree-root",
    parentNodeId: "node-root",
    name: "child",
    depth: 1,
    branch: "sheltie/root-child",
    baseCommit: "a".repeat(40),
    worktreePath: "/tmp/child",
    taskContract: "complete the child task",
  });
  store.reserveStep({
    operationId: "step-root",
    nodeId: "node-root",
    runNumber: 1,
    iterationNumber: 1,
    stepNumber: 1,
    promptSha256: "b".repeat(64),
  });
  store.sendMessage({
    messageId: "message-child",
    treeId: "tree-root",
    senderNodeId: "node-child",
    recipientNodeId: "node-root",
    channel: "inbox",
    kind: "progress",
    priority: 4,
    replyToMessageId: null,
    body: "child result",
  });
}

async function serveNotRunning(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "sheltie-agent-caller-herdr-"));
  roots.push(root);
  const socketPath = join(root, "herdr.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as { id: string; method: string };
      socket.end(
        `${JSON.stringify({
          id: request.id,
          error: { code: "agent_not_running", message: "the Agent is stopped" },
        })}\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

async function serveAgents(resultForCall: (call: number) => AgentInfo, onCall: (call: number) => void = () => {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "sheltie-agent-caller-herdr-"));
  roots.push(root);
  const socketPath = join(root, "herdr.sock");
  let calls = 0;
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as { id: string };
      calls += 1;
      onCall(calls);
      socket.end(`${JSON.stringify({ id: request.id, result: { type: "agent_info", agent: resultForCall(calls) } })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

describe("AgentCallerAuthenticator", () => {
  test("accepts the exact fresh Agent bound to the caller pane", async () => {
    const fixture = createFixture();
    const herdr = new FakeCallerHerdr(agent());
    const caller = await new AgentCallerAuthenticator(() => herdr).authenticate({
      databasePath: fixture.databasePath,
      callerPaneId: "workspace-root:pane-root",
      expectedNodeId: "node-root",
    });
    expect(caller.node.nodeId).toBe("node-root");
    expect(caller.tree.treeId).toBe("tree-root");
    expect(herdr.targets).toEqual(["agent-root"]);
    fixture.store.close();
  });

  test("rejects missing or empty instance identity without a terminal fallback", async () => {
    for (const value of [undefined, ""]) {
      const fixture = createFixture();
      const current = agent();
      if (value === undefined) delete current.agent_instance_id;
      else current.agent_instance_id = value;
      await expect(
        new AgentCallerAuthenticator(() => new FakeCallerHerdr(current)).authenticate({
          databasePath: fixture.databasePath,
          callerPaneId: "workspace-root:pane-root",
        }),
      ).rejects.toThrow("no per-launch instance identity");
      fixture.store.close();
    }
  });

  test("rejects a same-pane, same-terminal replacement with a changed instance", async () => {
    const fixture = createFixture();
    await expect(
      new AgentCallerAuthenticator(
        () => new FakeCallerHerdr(agent({ agent_instance_id: "instance-replacement" })),
      ).authenticate({
        databasePath: fixture.databasePath,
        callerPaneId: "workspace-root:pane-root",
      }),
    ).rejects.toThrow("instance drift");
    fixture.store.close();
  });

  test("rejects a target-node mismatch before reading Herdr", async () => {
    const fixture = createFixture();
    seedChildAndStep(fixture.store);
    const herdr = new FakeCallerHerdr(agent());
    await expect(
      new AgentCallerAuthenticator(() => herdr).authenticate({
        databasePath: fixture.databasePath,
        callerPaneId: "workspace-root:pane-root",
        expectedNodeId: "node-child",
      }),
    ).rejects.toThrow("not expected node node-child");
    expect(herdr.calls).toBe(0);
    fixture.store.close();
  });

  test("rejects missing and stopped Agents before a caller is authenticated", async () => {
    const fixture = createFixture();
    for (const code of ["agent_not_found", "agent_not_running"]) {
      await expect(
        new AgentCallerAuthenticator(
          () => new FakeCallerHerdr(new HerdrApiError(code, "missing", "test")),
        ).authenticate({
          databasePath: fixture.databasePath,
          callerPaneId: "workspace-root:pane-root",
        }),
      ).rejects.toThrow(code);
    }
    fixture.store.close();
  });

  test("rejects incomplete stored Agent identity before reading Herdr", async () => {
    const fixture = createFixture("/unused/herdr.sock", false);
    const herdr = new FakeCallerHerdr(agent());
    await expect(
      new AgentCallerAuthenticator(() => herdr).authenticate({
        databasePath: fixture.databasePath,
        callerPaneId: "workspace-root:pane-root",
      }),
    ).rejects.toThrow("must be a non-empty string");
    expect(herdr.calls).toBe(0);
    fixture.store.close();
  });
});

describe("agent-facing CLI authentication", () => {
  test("rejects every mutation route before its first durable write when the Agent is stopped", async () => {
    const socketPath = await serveNotRunning();

    const fixture = createFixture(socketPath);
    seedChildAndStep(fixture.store);
    const caller = ["--db", fixture.databasePath, "--caller-pane", "workspace-root:pane-root"];

    await expect(
      runCli(["spawn", ...caller, "--request-key", "child", "--name", "child", "--role", "worker"]),
    ).rejects.toThrow("agent_not_running");
    await expect(runCli(["step", "claim", ...caller, "--operation-id", "step-root"])).rejects.toThrow("agent_not_running");
    await expect(
      runCli(["step", "complete", ...caller, "--operation-id", "step-root", "--commit", "c".repeat(40)]),
    ).rejects.toThrow("agent_not_running");
    await expect(runCli(["node", "finish", ...caller, "--node-id", "node-root"])).rejects.toThrow("agent_not_running");
    await expect(runCli(["sync", ...caller])).rejects.toThrow("agent_not_running");
    await expect(
      runCli(["message", "send", ...caller, "--to", "node-child", "--body", "root response"]),
    ).rejects.toThrow("agent_not_running");
    await expect(runCli(["merge", ...caller, "--child-node", "node-child"])).rejects.toThrow("agent_not_running");

    expect(fixture.store.listNodes("tree-root").map((node) => node.nodeId)).toEqual(["node-root", "node-child"]);
    expect(fixture.store.getStep("step-root")).toMatchObject({ status: "reserved", claimCount: 0 });
    expect(fixture.store.getNode("node-root").lifecycleStatus).toBe("agent_ready");
    expect(fixture.store.listMessages("tree-root").map((message) => message.messageId)).toEqual(["message-child"]);
    expect(fixture.store.hasReadReceipt("message-child", "node-root")).toBe(false);
    expect(fixture.store.listOperations("tree-root")).toEqual([]);
    fixture.store.close();
  });
  test("rejects invalid message kinds before mutation and round-trips progress and result kinds", async () => {
    const socketPath = await serveAgents(() => agent());
    const fixture = createFixture(socketPath);
    fixture.store.reserveNode({
      nodeId: "node-child",
      treeId: "tree-root",
      parentNodeId: "node-root",
      name: "child",
      depth: 1,
      branch: "sheltie/root-child",
      baseCommit: "a".repeat(40),
      worktreePath: "/tmp/child",
      taskContract: "complete child",
    });
    const caller = ["--db", fixture.databasePath, "--caller-pane", "workspace-root:pane-root"];

    await expect(
      runCli(["message", "send", ...caller, "--to", "node-child", "--body", "invalid", "--kind", "completion"]),
    ).rejects.toThrow("--kind must be progress or result");
    expect(fixture.store.listMessages("tree-root")).toEqual([]);

    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runCli(["message", "send", ...caller, "--to", "node-child", "--body", "update"]);
      fixture.store.setNodeLifecycle("node-root", "completed");
      await runCli(["message", "send", ...caller, "--to", "node-child", "--body", "final", "--kind", "result"]);
      fixture.store.sendMessage({
        messageId: "message-child-progress",
        treeId: "tree-root",
        senderNodeId: "node-child",
        recipientNodeId: "node-root",
        channel: "inbox",
        kind: "progress",
        priority: 4,
        replyToMessageId: null,
        body: "child update",
      });
      await runCli(["sync", ...caller]);

      const output = stdout.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(output[0]).toMatchObject({ kind: "progress" });
      expect(output[1]).toMatchObject({ kind: "result" });
      expect(output[2]).toMatchObject({
        messages: [expect.objectContaining({ messageId: "message-child-progress", kind: "progress" })],
      });
    } finally {
      stdout.mockRestore();
    }
    expect(
      fixture.store.listMessages("tree-root").map((message) => `${message.messageId}:${message.kind}`),
    ).toEqual(expect.arrayContaining([
      expect.stringMatching(/^.+:progress$/),
      expect.stringMatching(/^.+:result$/),
    ]));
    fixture.store.close();
  });

  test("does not create a missing database file or parent directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-agent-caller-missing-"));
    roots.push(root);
    const missingDirectory = join(root, "state");
    const databasePath = join(missingDirectory, "state.sqlite");
    await expect(
      runCli(["sync", "--db", databasePath, "--caller-pane", "workspace-root:pane-root"]),
    ).rejects.toThrow("state database");
    expect(existsSync(missingDirectory)).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  test("leaves a legacy database byte-for-byte and schema-for-schema unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-agent-caller-legacy-"));
    roots.push(root);
    const databasePath = join(root, "state.sqlite");
    const database = new Database(databasePath, { create: true, strict: true });
    database.exec(`CREATE TABLE trees (
      tree_id TEXT PRIMARY KEY, herdr_socket_path TEXT NOT NULL,
      herdr_protocol INTEGER NOT NULL, worktree_root TEXT NOT NULL
    ) STRICT;
    CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, pane_id TEXT,
      agent_name TEXT, terminal_id TEXT
    ) STRICT;`);
    database.close();
    const before = readFileSync(databasePath);
    await expect(
      runCli(["sync", "--db", databasePath, "--caller-pane", "workspace-root:pane-root"]),
    ).rejects.toThrow("nodes.agent_instance_id");
    expect(readFileSync(databasePath)).toEqual(before);
    const readonly = new Database(databasePath, { readonly: true, strict: true });
    expect(
      (readonly.query("PRAGMA table_info('nodes')").all() as { name: string }[]).map(({ name }) => name),
    ).toEqual(["node_id", "tree_id", "pane_id", "agent_name", "terminal_id"]);
    readonly.close();
  });

  test("does not receipt or reveal a message after the waiting caller is replaced", async () => {
    let observedInitial!: () => void;
    const initial = new Promise<void>((resolve) => {
      observedInitial = resolve;
    });
    const socketPath = await serveAgents(
      (call) => (call === 1 ? agent() : agent({ agent_instance_id: "instance-replacement" })),
      (call) => {
        if (call === 1) observedInitial();
      },
    );
    const fixture = createFixture(socketPath);
    fixture.store.reserveNode({
      nodeId: "node-child",
      treeId: "tree-root",
      parentNodeId: "node-root",
      name: "child",
      depth: 1,
      branch: "sheltie/root-child",
      baseCommit: "a".repeat(40),
      worktreePath: "/tmp/child",
      taskContract: "complete child",
    });
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const syncing = runCli([
        "sync", "--db", fixture.databasePath, "--caller-pane", "workspace-root:pane-root", "--wait-ms", "1000",
      ]);
      await initial;
      fixture.store.sendMessage({
        messageId: "message-stale",
        treeId: "tree-root",
        senderNodeId: "node-child",
        recipientNodeId: "node-root",
        channel: "inbox",
        kind: "progress",
        priority: 4,
        replyToMessageId: null,
        body: "fresh-caller-only",
      });
      await expect(syncing).rejects.toThrow("instance drift");
      expect(stdout.mock.calls.flat().join("")).not.toContain("fresh-caller-only");
    } finally {
      stdout.mockRestore();
    }
    expect(fixture.store.hasReadReceipt("message-stale", "node-root")).toBe(false);
    fixture.store.close();
  });
});
