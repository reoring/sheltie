import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheltieStore } from "../src/db.ts";
import { HerdrApiError } from "../src/herdr-client.ts";
import type {
  AgentInfo,
  PaneInfo,
  PongResult,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
  WorktreeInfo,
} from "../src/herdr-client.ts";
import { agentNameForNode, operationIdForRequest, requestHash } from "../src/ids.ts";
import { type HerdrControl, SheltieOrchestrator } from "../src/orchestrator.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(
  workspaceId: string,
  checkoutPath?: string,
  label = workspaceId,
  isLinkedWorktree = true,
): WorkspaceInfo {
  return {
    workspace_id: workspaceId,
    label,
    focused: false,
    active_tab_id: `${workspaceId}:t1`,
    ...(checkoutPath === undefined
      ? {}
      : {
          worktree: {
            repo_root: checkoutPath,
            checkout_path: checkoutPath,
            is_linked_worktree: isLinkedWorktree,
          },
        }),
  };
}

function pane(workspaceId: string, paneId: string): PaneInfo {
  return {
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    pane_id: paneId,
    agent_status: "idle",
  };
}

function agent(nodeId: string, workspaceId: string, paneId: string): AgentInfo {
  return {
    terminal_id: `terminal-${nodeId}`,
    agent_instance_id: `instance-${nodeId}`,
    name: agentNameForNode(nodeId),
    agent: "omp",
    agent_status: "idle",
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    pane_id: paneId,
    launch_pending: false,
    interactive_ready: true,
    agent_session: { source: "test", agent: "omp", kind: "id", value: `session-${nodeId}` },
  };
}

class FakeHerdr implements HerdrControl {
  readonly worktreeCreates: Record<string, unknown>[] = [];
  readonly prompts: Array<{ target: string; text: string; client_operation_id?: string }> = [];
  readonly acceptedPromptOperations = new Set<string>();
  promptWrites = 0;
  agentStartCalls = 0;
  agentStartBusyAttempts = 0;
  omitAgentInstance = false;
  workspaceCreateCalls = 0;
  readonly workspaceCreates: Record<string, unknown>[] = [];
  snapshotValue: SessionSnapshot = {
    version: "0.8.0",
    protocol: 20,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
  };
  worktrees: WorktreeInfo[] = [];

  ping(): Promise<PongResult> {
    return Promise.resolve({ type: "pong", version: "0.8.0", protocol: 20, capabilities: null });
  }

  snapshot(): Promise<SessionSnapshot> {
    return Promise.resolve(this.snapshotValue);
  }

  workspaceCreate(params: {
    cwd: string;
    focus?: boolean;
    label?: string;
    env?: Record<string, string>;
  }): Promise<{ type: "workspace_created"; workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }> {
    this.workspaceCreateCalls += 1;
    this.workspaceCreates.push(params);
    const workspaceId = `w-root-${this.workspaceCreateCalls}`;
    const createdWorkspace = workspace(workspaceId, params.cwd, params.label, false);
    const createdTab = { workspace_id: workspaceId, tab_id: `${workspaceId}:t1` };
    const rootPane = pane(workspaceId, `${workspaceId}:p1`);
    this.snapshotValue = {
      ...this.snapshotValue,
      workspaces: [...this.snapshotValue.workspaces, createdWorkspace],
      tabs: [...this.snapshotValue.tabs, createdTab],
      panes: [...this.snapshotValue.panes, rootPane],
    };
    return Promise.resolve({
      type: "workspace_created",
      workspace: createdWorkspace,
      tab: createdTab,
      root_pane: rootPane,
    });
  }

  worktreeList(): Promise<{
    type: "worktree_list";
    source: { repo_root: string; source_workspace_id?: string };
    worktrees: WorktreeInfo[];
  }> {
    return Promise.resolve({
      type: "worktree_list",
      source: { repo_root: "/tmp/repo", source_workspace_id: "w1" },
      worktrees: this.worktrees,
    });
  }

  worktreeCreate(params: {
    workspace_id?: string;
    cwd?: string;
    branch: string;
    path?: string;
    label?: string;
    focus?: boolean;
  }): Promise<{
    type: "worktree_created";
    workspace: WorkspaceInfo;
    tab: TabInfo;
    root_pane: PaneInfo;
    worktree: WorktreeInfo;
  }> {
    this.worktreeCreates.push(params);
    const targetWorkspace = workspace("w2", params.path);
    return Promise.resolve({
      type: "worktree_created",
      workspace: targetWorkspace,
      tab: { tab_id: "w2:t1", workspace_id: "w2" },
      root_pane: pane("w2", "w2:p1"),
      worktree: {
        path: params.path ?? "/tmp/worktrees/root",
        branch: params.branch,
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        open_workspace_id: "w2",
        label: params.label ?? params.branch,
      },
    });
  }

  tabCreate(): Promise<never> {
    return Promise.reject(new Error("tabCreate was not expected"));
  }

  tabRename(params: { tab_id: string; label: string }): Promise<{ type: "tab_info"; tab: TabInfo }> {
    const tab = this.snapshotValue.tabs.find((candidate) => candidate.tab_id === params.tab_id);
    if (tab !== undefined) tab.label = params.label;
    return Promise.resolve({
      type: "tab_info",
      tab: tab ?? { tab_id: params.tab_id, workspace_id: params.tab_id.split(":")[0] ?? "w2", label: params.label },
    });
  }

  async agentStart(params: { name: string; kind: string; pane_id: string }): Promise<{
    type: "agent_started";
    agent: AgentInfo;
    argv: string[];
  }> {
    this.agentStartCalls += 1;
    if (this.agentStartBusyAttempts > 0) {
      this.agentStartBusyAttempts -= 1;
      throw new HerdrApiError("agent_pane_busy", "pane shell is not ready", "test-request");
    }
    const started = agent("node-root", "w2", params.pane_id);
    if (this.omitAgentInstance) delete started.agent_instance_id;
    return {
      type: "agent_started",
      agent: started,
      argv: [params.kind],
    };
  }

  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    const found = this.snapshotValue.agents.find(
      (candidate) => candidate.name === target || candidate.pane_id === target,
    );
    const current = found ?? agent("node-root", "w2", "w2:p1");
    if (this.omitAgentInstance) delete current.agent_instance_id;
    return Promise.resolve({ type: "agent_info", agent: current });
  }

  agentPrompt(params: {
    target: string;
    text: string;
    client_operation_id?: string;
    wait?: { until?: AgentInfo["agent_status"][]; timeout_ms?: number };
  }): Promise<{
    type: "agent_prompted";
    agent: AgentInfo;
    turn_id: string;
    client_operation_id?: string;
    duplicate: boolean;
  }> {
    this.prompts.push(params);
    const operationId = params.client_operation_id;
    const duplicate = operationId !== undefined && this.acceptedPromptOperations.has(operationId);
    if (!duplicate) {
      this.promptWrites += 1;
      if (operationId !== undefined) this.acceptedPromptOperations.add(operationId);
    }
    return Promise.resolve({
      type: "agent_prompted",
      agent: agent("node-root", "w2", "w2:p1"),
      turn_id: operationId === undefined ? "turn-ephemeral" : `turn-${operationId}`,
      ...(operationId === undefined ? {} : { client_operation_id: operationId }),
      duplicate,
    });
  }
}

function seedStore(): { store: SheltieStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "sheltie-orchestrator-"));
  roots.push(root);
  const store = new SheltieStore(join(root, "state.sqlite"));
  store.createTree({
    treeId: "tree-1",
    runId: "run-1",
    repoRoot: "/tmp/repo",
    repoSourceWorkspaceId: null,
    herdrSocketPath: join(root, "herdr.sock"),
    herdrVersion: "0.8.0",
    herdrProtocol: 19,
    baseCommit: "a".repeat(40),
    worktreeRoot: join(root, "worktrees"),
    status: "active",
    rootTaskContract: "create the root result",
  });
  store.reserveNode({
    nodeId: "node-root",
    treeId: "tree-1",
    parentNodeId: null,
    name: "root",
    depth: 0,
    branch: "sheltie/root",
    baseCommit: "a".repeat(40),
    worktreePath: join(root, "worktrees/root"),
    taskContract: "create the root result",
  });
  return { store, root };
}

function seedRootWorkspaceStore(): { store: SheltieStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "sheltie-root-workspace-"));
  roots.push(root);
  const store = new SheltieStore(join(root, "state.sqlite"));
  store.createTree({
    treeId: "tree-root-workspace",
    runId: "run-root-workspace",
    repoRoot: "/tmp/repo",
    repoSourceWorkspaceId: null,
    herdrSocketPath: join(root, "herdr.sock"),
    herdrVersion: "0.8.0",
    herdrProtocol: 20,
    baseCommit: "a".repeat(40),
    worktreeRoot: join(root, "worktrees"),
    status: "active",
    rootTaskContract: "create the root result",
  });
  store.reserveNode({
    nodeId: "node-root-workspace",
    treeId: "tree-root-workspace",
    parentNodeId: null,
    name: "root",
    depth: 0,
    branch: "sheltie/root-workspace",
    baseCommit: "a".repeat(40),
    worktreePath: "/tmp/repo",
    taskContract: "create the root result",
  });
  return { store, root };
}

describe("node provisioning", () => {
  test("uses the repository cwd without a source workspace and waits for a newly-created pane shell", async () => {
    const { store } = seedStore();
    const herdr = new FakeHerdr();
    herdr.agentStartBusyAttempts = 2;
    const orchestrator = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: "/workspace/sheltie/dist/sheltie",
    });

    const provisioned = await orchestrator.provisionNode("node-root");

    expect(herdr.worktreeCreates).toEqual([
      expect.objectContaining({ cwd: "/tmp/repo", branch: "sheltie/root", base: "a".repeat(40) }),
    ]);
    expect(herdr.agentStartCalls).toBe(3);
    expect(provisioned).toMatchObject({
      workspaceId: "w2",
      paneId: "w2:p1",
      agentName: agentNameForNode("node-root"),
      lifecycleStatus: "agent_ready",
    });
    store.close();
  });

  test("refuses to bind an Agent response without a protocol-20 launch instance", async () => {
    const { store } = seedStore();
    const herdr = new FakeHerdr();
    herdr.omitAgentInstance = true;
    const orchestrator = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: "/workspace/sheltie/dist/sheltie",
    });

    await expect(orchestrator.provisionNode("node-root")).rejects.toThrow("per-launch instance identity");
    expect(store.getNode("node-root").agentInstanceId).toBeNull();
    store.close();
  });
});

describe("root workspace identity", () => {
  test("rebinds one response-lost root workspace by its deterministic node label", async () => {
    const { store, root } = seedRootWorkspaceStore();
    const node = store.getNode("node-root-workspace");
    const herdr = new FakeHerdr();
    herdr.snapshotValue = {
      version: "0.8.0",
      protocol: 20,
      workspaces: [workspace("w-foreign", "/tmp/repo", "root", false)],
      tabs: [{ workspace_id: "w-foreign", tab_id: "w-foreign:t1", label: "coord" }],
      panes: [pane("w-foreign", "w-foreign:p1")],
      agents: [],
    };
    let failpointArmed = true;
    const first = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: join(root, "sheltie"),
      failpoint: (name) => {
        if (name === "before_worktree_response_persist" && failpointArmed) {
          failpointArmed = false;
          throw new Error("workspace response lost");
        }
      },
    });

    await expect(first.provisionNode(node.nodeId)).rejects.toThrow("workspace response lost");
    expect(herdr.workspaceCreates).toEqual([
      expect.objectContaining({ cwd: "/tmp/repo", label: node.nodeId }),
    ]);
    expect(store.getNode(node.nodeId).workspaceId).toBeNull();

    const restored = new SheltieOrchestrator(store, herdr, { sheltieExecutable: join(root, "sheltie") });
    const rebound = await restored.reconcileNode(node.nodeId);
    const workspaceOperationId = operationIdForRequest(node.treeId, "workspace_create", node.nodeId);

    expect(rebound).toMatchObject({
      workspaceId: "w-root-1",
      tabId: "w-root-1:t1",
      paneId: "w-root-1:p1",
    });
    expect(store.getTree(node.treeId).repoSourceWorkspaceId).toBe("w-root-1");
    expect(store.getOperation(workspaceOperationId).status).toBe("completed");
    expect(herdr.workspaceCreateCalls).toBe(1);
    expect(herdr.snapshotValue.workspaces.map((candidate) => candidate.workspace_id)).toEqual([
      "w-foreign",
      "w-root-1",
    ]);
    store.close();
  });

  test("does not adopt a foreign same-name root workspace after workspace response loss", async () => {
    const { store, root } = seedRootWorkspaceStore();
    const node = store.getNode("node-root-workspace");
    const operationId = operationIdForRequest(node.treeId, "workspace_create", node.nodeId);
    const request = { cwd: "/tmp/repo", label: node.nodeId };
    store.reserveOperation({
      operationId,
      treeId: node.treeId,
      nodeId: node.nodeId,
      kind: "workspace_create",
      requestKey: node.nodeId,
      requestHash: requestHash(request),
      request,
    });
    store.setOperationStatus(operationId, "delivery_unknown", { lastError: "workspace response lost" });
    const herdr = new FakeHerdr();
    herdr.snapshotValue = {
      version: "0.8.0",
      protocol: 20,
      workspaces: [workspace("w-foreign", "/tmp/repo", "root", false)],
      tabs: [{ workspace_id: "w-foreign", tab_id: "w-foreign:t1", label: "coord" }],
      panes: [pane("w-foreign", "w-foreign:p1")],
      agents: [],
    };
    const orchestrator = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: join(root, "sheltie"),
    });

    await expect(orchestrator.reconcileNode(node.nodeId)).rejects.toThrow(
      "expected one repository workspace; found 0",
    );

    expect(store.getNode(node.nodeId).workspaceId).toBeNull();
    expect(store.getTree(node.treeId).repoSourceWorkspaceId).toBeNull();
    expect(store.getOperation(operationId).status).toBe("delivery_unknown");
    expect(herdr.workspaceCreateCalls).toBe(0);
    expect(herdr.snapshotValue.workspaces.map((candidate) => candidate.workspace_id)).toEqual(["w-foreign"]);
    store.close();
  });
});

describe("runtime reconciliation", () => {
  test("rebinds locators by exact worktree path and deterministic agent name", async () => {
    const { store, root } = seedStore();
    const node = store.getNode("node-root");
    const expectedAgent = agent("node-root", "w9", "w9:p1");
    const herdr = new FakeHerdr();
    herdr.worktrees = [
      {
        path: node.worktreePath,
        branch: node.branch,
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        open_workspace_id: "w9",
        label: "root",
      },
    ];
    herdr.snapshotValue = {
      version: "0.8.0",
      protocol: 20,
      workspaces: [workspace("w9", node.worktreePath)],
      tabs: [{ workspace_id: "w9", tab_id: "w9:t1" }],
      panes: [pane("w9", "w9:p1")],
      agents: [expectedAgent],
    };
    const orchestrator = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: join(root, "sheltie"),
    });

    const rebound = await orchestrator.reconcileNode("node-root");

    expect(rebound).toMatchObject({
      workspaceId: "w9",
      tabId: "w9:t1",
      paneId: "w9:p1",
      agentName: agentNameForNode("node-root"),
      agentSession: "session-node-root",
    });
    store.close();
  });

  test("blocks ambiguous duplicate agents instead of guessing a runtime locator", async () => {
    const { store, root } = seedStore();
    const node = store.getNode("node-root");
    const herdr = new FakeHerdr();
    herdr.worktrees = [
      {
        path: node.worktreePath,
        branch: node.branch,
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        open_workspace_id: "w9",
        label: "root",
      },
    ];
    herdr.snapshotValue = {
      version: "0.8.0",
      protocol: 20,
      workspaces: [workspace("w9", node.worktreePath)],
      tabs: [{ workspace_id: "w9", tab_id: "w9:t1" }],
      panes: [pane("w9", "w9:p1"), pane("w9", "w9:p2")],
      agents: [agent("node-root", "w9", "w9:p1"), agent("node-root", "w9", "w9:p2")],
    };
    const orchestrator = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: join(root, "sheltie"),
    });

    await expect(orchestrator.reconcileNode("node-root")).rejects.toThrow("duplicate agent name");
    store.close();
  });
});

describe("prompt operation idempotency", () => {
  test("does not resubmit a prompt whose operation is already recorded", async () => {
    const { store, root } = seedStore();
    store.bindWorktree("node-root", { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1" });
    store.bindAgent("node-root", {
      agentName: agentNameForNode("node-root"),
      agentSession: "session-node-root",
      terminalId: "terminal-node-root",
      agentInstanceId: "instance-node-root",
    });
    const herdr = new FakeHerdr();
    const orchestrator = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: join(root, "sheltie"),
    });

    const first = await orchestrator.dispatchStep("node-root", "initial", "create result.txt");
    const replay = await orchestrator.dispatchStep("node-root", "initial", "create result.txt");

    expect(replay.operationId).toBe(first.operationId);
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.promptWrites).toBe(1);
    expect(herdr.prompts[0]).toMatchObject({ client_operation_id: first.operationId });
    expect(herdr.prompts[0]?.text).toContain("node finish --db");
    expect(herdr.prompts[0]?.text).toContain("sync --db");
    expect(herdr.prompts[0]?.text).toContain("--wait-ms 180000");
    expect(herdr.prompts[0]?.text).toContain("merge --db");
    expect(herdr.prompts[0]?.text).toContain("--child-node <child-node-id>");
    const prompt = herdr.prompts[0]?.text ?? "";
    expect(prompt.match(/--caller-pane "\$HERDR_PANE_ID"/g)).toHaveLength(8);
    expect(prompt).not.toContain("--agent-session");
    expect(prompt).not.toContain("--parent-pane");
    expect(store.claimStep(first.operationId, "session-node-root")).toEqual({ outcome: "claimed" });
    expect(store.claimStep(first.operationId, "other-session")).toEqual({ outcome: "conflict" });
    store.close();
  });

  test("orders a non-root final result after step completion and node finish", async () => {
    const { store, root } = seedStore();
    store.reserveNode({
      nodeId: "node-child",
      treeId: "tree-1",
      parentNodeId: "node-root",
      name: "child",
      depth: 1,
      placement: "tab",
      spawnPolicy: "none",
      branch: "sheltie/root",
      baseCommit: "a".repeat(40),
      worktreePath: join(root, "worktrees/root"),
      taskContract: "report findings",
    });
    store.bindWorktree("node-child", { workspaceId: "w2", tabId: "w2:t2", paneId: "w2:p2" });
    store.bindAgent("node-child", {
      agentName: agentNameForNode("node-child"),
      terminalId: "terminal-node-child",
      agentInstanceId: "instance-node-child",
    });
    const herdr = new FakeHerdr();
    const orchestrator = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: join(root, "sheltie"),
    });

    await orchestrator.dispatchStep("node-child", "initial", "report findings");

    const prompt = herdr.prompts[0]?.text ?? "";
    expect(prompt).toContain("--kind progress");
    expect(prompt).toContain("progress/message != completion");
    expect(prompt).toContain("only after its result-kind message arrives from a completed sender");
    expect(prompt).not.toContain("Send a concrete result to the parent before finishing:");
    const stepCompleteIndex = prompt.indexOf("step complete --db");
    const nodeFinishIndex = prompt.indexOf("node finish --db");
    const resultIndex = prompt.indexOf("--kind result");
    expect(stepCompleteIndex).toBeGreaterThan(-1);
    expect(nodeFinishIndex).toBeGreaterThan(stepCompleteIndex);
    expect(resultIndex).toBeGreaterThan(nodeFinishIndex);
    store.close();
  });

  test("retries a response-lost prompt with the same native operation id and one terminal write", async () => {
    const { store, root } = seedStore();
    store.bindWorktree("node-root", { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1" });
    store.bindAgent("node-root", {
      agentName: agentNameForNode("node-root"),
      agentSession: "session-node-root",
      terminalId: "terminal-node-root",
      agentInstanceId: "instance-node-root",
    });
    const herdr = new FakeHerdr();
    let failpointArmed = true;
    const orchestrator = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: join(root, "sheltie"),
      failpoint: (name) => {
        if (name === "after_prompt_request" && failpointArmed) {
          failpointArmed = false;
          throw new Error("response lost");
        }
      },
    });

    const first = await orchestrator.dispatchStep("node-root", "initial", "create result.txt");
    const replay = await orchestrator.dispatchStep("node-root", "initial", "create result.txt");

    expect(first.status).toBe("delivery_unknown");
    expect(replay.operationId).toBe(first.operationId);
    expect(replay.status).toBe("observed");
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.promptWrites).toBe(1);
    expect(herdr.prompts[1]).toMatchObject({ client_operation_id: first.operationId });
    expect(store.claimStep(first.operationId, "session-node-root")).toEqual({ outcome: "claimed" });
    store.close();
  });
});
