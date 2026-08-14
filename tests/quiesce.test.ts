import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheltieStore } from "../src/db.ts";
import { HerdrApiError, type AgentInfo, type PongResult } from "../src/herdr-client.ts";
import { QuiesceController, type QuiesceHerdrControl } from "../src/quiesce.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agent(
  name: string,
  workspaceId: string,
  terminalId: string,
  instanceId: string,
  paneId = `${workspaceId}:p1`,
): AgentInfo {
  return {
    terminal_id: terminalId,
    agent_instance_id: instanceId,
    name,
    agent: "omp",
    agent_status: "done",
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    pane_id: paneId,
    launch_pending: false,
    interactive_ready: true,
  };
}

class FakeQuiesceHerdr implements QuiesceHerdrControl {
  readonly calls: string[] = [];
  readonly agents = new Map<string, AgentInfo>();
  readonly stubborn = new Set<string>();
  readonly loseTerminateResponse = new Set<string>();
  stoppedErrorCode: "agent_not_found" | "agent_not_running" = "agent_not_found";

  ping(): Promise<PongResult> {
    return Promise.resolve({
      type: "pong",
      version: "0.8.0",
      protocol: 20,
      capabilities: { agent_control: true },
    });
  }

  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    const found = this.agents.get(target);
    if (found === undefined) {
      return Promise.reject(new HerdrApiError(this.stoppedErrorCode, `agent ${target} stopped`, "fake"));
    }
    return Promise.resolve({ type: "agent_info", agent: found });
  }

  agentWait(params: { target: string }): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    return this.agentGet(params.target);
  }

  agentTerminate(params: {
    target: string;
    client_operation_id: string;
    expected_terminal_id: string;
    expected_agent_instance_id: string;
    force: boolean;
  }): Promise<{
    type: "agent_controlled";
    action: "interrupt" | "terminate";
    client_operation_id: string;
    terminal_id: string;
    agent_instance_id: string;
    outcome: "interrupt_sent" | "terminate_sent" | "kill_sent" | "already_stopped";
    duplicate: boolean;
  }> {
    this.calls.push(`${params.force ? "kill" : "terminate"}:${params.target}`);
    if (params.force || !this.stubborn.has(params.target)) this.agents.delete(params.target);
    if (!params.force && this.loseTerminateResponse.delete(params.target)) {
      return Promise.reject(
        new HerdrApiError("agent_control_delivery_unknown", "terminate response lost", params.client_operation_id),
      );
    }
    return Promise.resolve({
      type: "agent_controlled",
      action: "terminate",
      client_operation_id: params.client_operation_id,
      terminal_id: params.expected_terminal_id,
      agent_instance_id: params.expected_agent_instance_id,
      outcome: params.force ? "kill_sent" : "terminate_sent",
      duplicate: false,
    });
  }
}

function createFixture(status: "active" | "completed" = "completed"): {
  store: SheltieStore;
  rootPath: string;
  childPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "sheltie-quiesce-"));
  roots.push(root);
  const rootPath = join(root, "root-worktree");
  const childPath = join(root, "child-worktree");
  mkdirSync(rootPath);
  mkdirSync(childPath);
  writeFileSync(join(rootPath, "result.txt"), "root artifact\n");
  writeFileSync(join(childPath, "result.txt"), "child artifact\n");
  const store = new SheltieStore(join(root, "state.sqlite"));
  store.createTree({
    treeId: "tree-quiesce",
    runId: "run-quiesce",
    repoRoot: root,
    repoSourceWorkspaceId: "w-source",
    herdrSocketPath: join(root, "herdr.sock"),
    herdrVersion: "0.8.0",
    herdrProtocol: 20,
    baseCommit: "a".repeat(40),
    worktreeRoot: root,
    rootTaskContract: "completed run",
    status,
  });
  store.reserveNode({
    nodeId: "node-root",
    treeId: "tree-quiesce",
    parentNodeId: null,
    name: "root",
    depth: 0,
    branch: "sheltie/root",
    baseCommit: "a".repeat(40),
    worktreePath: rootPath,
    taskContract: "root",
  });
  store.bindWorktree("node-root", { workspaceId: "w-root", tabId: "w-root:t1", paneId: "w-root:p1" });
  store.bindAgent("node-root", {
    agentName: "root-agent",
    agentSession: "root-session",
    terminalId: "term-root",
    agentInstanceId: "instance-root",
  });
  store.setNodeLifecycle("node-root", "completed");
  store.reserveNode({
    nodeId: "node-child",
    treeId: "tree-quiesce",
    parentNodeId: "node-root",
    name: "child",
    depth: 1,
    branch: "sheltie/root.child",
    baseCommit: "a".repeat(40),
    worktreePath: childPath,
    taskContract: "child",
  });
  store.bindWorktree("node-child", { workspaceId: "w-child", tabId: "w-child:t1", paneId: "w-child:p1" });
  store.bindAgent("node-child", {
    agentName: "child-agent",
    agentSession: "child-session",
    terminalId: "term-child",
    agentInstanceId: "instance-child",
  });
  store.setNodeLifecycle("node-child", "completed");
  return { store, rootPath, childPath };
}

describe("QuiesceController", () => {
  test("stops completed agents leaf-first, reconciles response loss, and preserves run artifacts", async () => {
    const fixture = createFixture();
    const herdr = new FakeQuiesceHerdr();
    herdr.agents.set("root-agent", agent("root-agent", "w-root", "term-root", "instance-root"));
    herdr.agents.set("child-agent", agent("child-agent", "w-child", "term-child", "instance-child"));
    herdr.stubborn.add("child-agent");
    herdr.loseTerminateResponse.add("root-agent");
    const controller = new QuiesceController(fixture.store, herdr, { graceMs: 1, forceWaitMs: 1 });

    const first = await controller.quiesceRun();
    const replay = await controller.quiesceRun();

    expect(first.tree.status).toBe("completed");
    expect(first.nodes.map((node) => node.lifecycleStatus)).toEqual(["completed", "completed"]);
    expect(first.unresolvedOperations).toEqual([]);
    expect(first.receipts.map((operation) => operation.status)).toEqual(["completed", "completed"]);
    expect(herdr.calls).toEqual([
      "terminate:child-agent",
      "kill:child-agent",
      "terminate:root-agent",
    ]);
    expect(first.receipts.map((operation) => operation.result)).toEqual([
      {
        nodeId: "node-child",
        terminalId: "term-child",
        agentInstanceId: "instance-child",
        forced: true,
        reconciled: false,
      },
      {
        nodeId: "node-root",
        terminalId: "term-root",
        agentInstanceId: "instance-root",
        forced: false,
        reconciled: true,
      },
    ]);
    expect(replay.receipts.map((operation) => operation.attempt)).toEqual([1, 1]);
    expect(existsSync(join(fixture.rootPath, "result.txt"))).toBe(true);
    expect(existsSync(join(fixture.childPath, "result.txt"))).toBe(true);
    fixture.store.close();
  });

  test("treats Herdr agent_not_running tombstones as already stopped", async () => {
    const fixture = createFixture();
    const herdr = new FakeQuiesceHerdr();
    herdr.stoppedErrorCode = "agent_not_running";

    const result = await new QuiesceController(fixture.store, herdr).quiesceRun();

    expect(herdr.calls).toEqual([]);
    expect(result.unresolvedOperations).toEqual([]);
    expect(result.receipts.map((operation) => operation.status)).toEqual(["completed", "completed"]);
    expect(result.receipts.map((operation) => operation.result)).toEqual([
      expect.objectContaining({ nodeId: "node-child", reconciled: true }),
      expect.objectContaining({ nodeId: "node-root", reconciled: true }),
    ]);
    fixture.store.close();
  });

  test("stops a tab Agent while preserving its shared parent worktree", async () => {
    const fixture = createFixture();
    fixture.store.reserveNode({
      nodeId: "node-reviewer",
      treeId: "tree-quiesce",
      parentNodeId: "node-root",
      name: "reviewer",
      depth: 1,
      placement: "tab",
      branch: "sheltie/root",
      baseCommit: "a".repeat(40),
      worktreePath: fixture.rootPath,
      taskContract: "review",
    });
    fixture.store.bindWorktree("node-reviewer", {
      workspaceId: "w-root",
      tabId: "w-root:t2",
      paneId: "w-root:p2",
    });
    fixture.store.bindAgent("node-reviewer", {
      agentName: "reviewer-agent",
      terminalId: "term-reviewer",
      agentInstanceId: "instance-reviewer",
    });
    fixture.store.setNodeLifecycle("node-reviewer", "completed");
    const herdr = new FakeQuiesceHerdr();
    herdr.agents.set(
      "reviewer-agent",
      agent("reviewer-agent", "w-root", "term-reviewer", "instance-reviewer", "w-root:p2"),
    );

    const result = await new QuiesceController(fixture.store, herdr, {
      graceMs: 1,
      forceWaitMs: 1,
    }).quiesceRun();

    expect(herdr.calls).toEqual(["terminate:reviewer-agent"]);
    expect(result.unresolvedOperations).toEqual([]);
    expect(result.receipts.find((operation) => operation.nodeId === "node-reviewer")).toMatchObject({
      kind: "quiesce",
      status: "completed",
    });
    expect(existsSync(join(fixture.rootPath, "result.txt"))).toBe(true);
    fixture.store.close();
  });

  test("rejects an active tree without signaling its agent", async () => {
    const fixture = createFixture("active");
    const herdr = new FakeQuiesceHerdr();
    herdr.agents.set("root-agent", agent("root-agent", "w-root", "term-root", "instance-root"));
    const controller = new QuiesceController(fixture.store, herdr);

    await expect(controller.quiesceRun()).rejects.toThrow("terminal tree");

    expect(herdr.calls).toEqual([]);
    expect(fixture.store.listOperations("tree-quiesce")).toEqual([]);
    fixture.store.close();
  });

  test("blocks an identity change without signaling the replacement agent", async () => {
    const fixture = createFixture();
    const herdr = new FakeQuiesceHerdr();
    herdr.agents.set("root-agent", agent("root-agent", "w-root", "term-root", "replacement-instance"));
    const controller = new QuiesceController(fixture.store, herdr);

    const result = await controller.quiesceRun();

    expect(herdr.calls).toEqual([]);
    expect(result.unresolvedOperations).toHaveLength(1);
    expect(result.unresolvedOperations[0]).toMatchObject({ kind: "quiesce", status: "blocked" });
    expect(result.tree.status).toBe("completed");
    fixture.store.close();
  });
});
