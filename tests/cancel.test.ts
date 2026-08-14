import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancellationController, type CancellationHerdrControl } from "../src/cancel.ts";
import { SheltieStore } from "../src/db.ts";
import { HerdrApiError, type AgentInfo, type PongResult } from "../src/herdr-client.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agent(name: string, workspaceId: string, paneId: string, terminalId: string, instanceId: string): AgentInfo {
  return {
    terminal_id: terminalId,
    agent_instance_id: instanceId,
    name,
    agent: "omp",
    agent_status: "working",
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    pane_id: paneId,
    launch_pending: false,
    interactive_ready: true,
  };
}


class FakeCancellationHerdr implements CancellationHerdrControl {
  readonly calls: string[] = [];
  readonly agents = new Map<string, AgentInfo>();
  readonly stubborn = new Set<string>();
  pingCalls = 0;
  ping(): Promise<PongResult> {
    this.pingCalls += 1;
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
      return Promise.reject(new HerdrApiError("agent_not_found", `agent ${target} stopped`, "fake"));
    }
    return Promise.resolve({ type: "agent_info", agent: found });
  }

  agentWait(params: { target: string }): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    return this.agentGet(params.target);
  }

  agentInterrupt(params: {
    target: string;
    client_operation_id: string;
    expected_terminal_id: string;
    expected_agent_instance_id: string;
  }): Promise<{
    type: "agent_controlled";
    action: "interrupt" | "terminate";
    client_operation_id: string;
    terminal_id: string;
    agent_instance_id: string;
    outcome: "interrupt_sent" | "terminate_sent" | "kill_sent" | "already_stopped";
    duplicate: boolean;
  }> {
    this.calls.push(`interrupt:${params.target}`);
    return Promise.resolve({
      type: "agent_controlled",
      action: "interrupt",
      client_operation_id: params.client_operation_id,
      terminal_id: params.expected_terminal_id,
      agent_instance_id: params.expected_agent_instance_id,
      outcome: "interrupt_sent",
      duplicate: false,
    });
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

function seedClaimedStep(store: SheltieStore, nodeId: string, paneId: string): void {
  const operationId = `prompt-${nodeId}`;
  store.reserveOperation({
    operationId,
    treeId: "tree-cancel",
    nodeId,
    kind: "prompt",
    requestKey: `${nodeId}/step/initial`,
    requestHash: `hash-${nodeId}`,
    request: { target: nodeId },
  });
  store.setOperationStatus(operationId, "observed");
  store.reserveStep({
    operationId,
    nodeId,
    runNumber: 1,
    iterationNumber: 1,
    stepNumber: 1,
    promptSha256: "a".repeat(64),
  });
  store.claimStep(operationId, paneId);
}

function createCancellationFixture(): {
  store: SheltieStore;
  rootPath: string;
  childPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "sheltie-cancel-"));
  roots.push(root);
  const rootPath = join(root, "root-worktree");
  const childPath = join(root, "child-worktree");
  mkdirSync(rootPath);
  mkdirSync(childPath);
  writeFileSync(join(rootPath, "dirty.txt"), "preserve root\n");
  writeFileSync(join(childPath, "dirty.txt"), "preserve child\n");
  const store = new SheltieStore(join(root, "state.sqlite"));
  store.createTree({
    treeId: "tree-cancel",
    runId: "run-cancel",
    repoRoot: root,
    repoSourceWorkspaceId: "w-source",
    herdrSocketPath: join(root, "herdr.sock"),
    herdrVersion: "0.8.0",
    herdrProtocol: 20,
    baseCommit: "a".repeat(40),
    worktreeRoot: root,
    rootTaskContract: "long running root",
    status: "active",
  });
  store.reserveNode({
    nodeId: "node-root",
    treeId: "tree-cancel",
    parentNodeId: null,
    name: "root",
    depth: 0,
    branch: "sheltie/root",
    baseCommit: "a".repeat(40),
    worktreePath: rootPath,
    taskContract: "long running root",
  });
  store.bindWorktree("node-root", { workspaceId: "w-root", tabId: "w-root:t1", paneId: "w-root:p1" });
  store.bindAgent("node-root", {
    agentName: "root-agent",
    agentSession: "root-session",
    terminalId: "term-root",
    agentInstanceId: "instance-root",
  });
  store.setNodeLifecycle("node-root", "running");
  seedClaimedStep(store, "node-root", "w-root:p1");
  store.reserveNode({
    nodeId: "node-child",
    treeId: "tree-cancel",
    parentNodeId: "node-root",
    name: "child",
    depth: 1,
    branch: "sheltie/root.child",
    baseCommit: "a".repeat(40),
    worktreePath: childPath,
    taskContract: "long running child",
  });
  store.bindWorktree("node-child", { workspaceId: "w-child", tabId: "w-child:t1", paneId: "w-child:p1" });
  store.bindAgent("node-child", {
    agentName: "child-agent",
    agentSession: "child-session",
    terminalId: "term-child",
    agentInstanceId: "instance-child",
  });
  store.setNodeLifecycle("node-child", "running");
  seedClaimedStep(store, "node-child", "w-child:p1");
  return { store, rootPath, childPath };
}

describe("safe cancellation", () => {
  test("latches cancellation before rejecting new child scope", () => {
    const fixture = createCancellationFixture();

    expect(fixture.store.requestCancellation().status).toBe("cancel_requested");
    expect(() =>
      fixture.store.reserveChildNode(
        {
          nodeId: "node-late",
          treeId: "tree-cancel",
          parentNodeId: "node-root",
          name: "late",
          depth: 1,
          branch: "sheltie/root.late",
          baseCommit: "a".repeat(40),
          worktreePath: join(fixture.rootPath, "late"),
          taskContract: "late work",
        },
        { maxDepth: 2, maxChildren: 5, maxDescendants: 10 },
      ),
    ).toThrow("is cancelling");
    fixture.store.close();
  });

  test("cancels leaf first, escalates only a stubborn instance, and preserves worktrees", async () => {
    const fixture = createCancellationFixture();
    const herdr = new FakeCancellationHerdr();
    herdr.agents.set("root-agent", agent("root-agent", "w-root", "w-root:p1", "term-root", "instance-root"));
    herdr.agents.set(
      "child-agent",
      agent("child-agent", "w-child", "w-child:p1", "term-child", "instance-child"),
    );
    herdr.stubborn.add("child-agent");
    const controller = new CancellationController(fixture.store, herdr, {
      graceMs: 1,
      forceWaitMs: 1,
    });

    const status = await controller.cancelRun();

    expect(status.tree.status).toBe("cancelled");
    expect(status.nodes.map((node) => [node.name, node.lifecycleStatus])).toEqual([
      ["root", "cancelled"],
      ["child", "cancelled"],
    ]);
    expect(herdr.calls).toEqual([
      "interrupt:child-agent",
      "terminate:child-agent",
      "kill:child-agent",
      "interrupt:root-agent",
      "terminate:root-agent",
    ]);
    expect(status.operations).toEqual([]);
    expect(status.steps.every((step) => step.status === "cancelled")).toBe(true);
    expect(existsSync(join(fixture.rootPath, "dirty.txt"))).toBe(true);
    expect(existsSync(join(fixture.childPath, "dirty.txt"))).toBe(true);
    fixture.store.close();
  });

  test("leaves a cleaned tree untouched without contacting agents", async () => {
    const fixture = createCancellationFixture();
    fixture.store.setTreeStatus("tree-cancel", "cleaned");
    const herdr = new FakeCancellationHerdr();
    const controller = new CancellationController(fixture.store, herdr, {
      graceMs: 1,
      forceWaitMs: 1,
    });
    const before = controller.status();

    expect(await controller.convergeOnce()).toEqual(before);
    expect(await controller.cancelRun()).toEqual(before);
    expect(fixture.store.requestCancellation()).toEqual(before.tree);
    expect(controller.status()).toEqual(before);
    expect(herdr.pingCalls).toBe(0);
    expect(herdr.calls).toEqual([]);
    fixture.store.close();
  });
});
