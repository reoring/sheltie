import { dirname } from "node:path";
import type { NodeRecord, OperationRecord } from "./db.ts";
import { SheltieStore } from "./db.ts";
import { resolveCommit } from "./git.ts";
import { HerdrApiError } from "./herdr-client.ts";
import type {
  AgentInfo,
  PaneInfo,
  PongResult,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
  WorktreeInfo,
} from "./herdr-client.ts";
import {
  agentNameForNode,
  branchForNode,
  nodeIdForRequest,
  operationIdForRequest,
  requestHash,
  worktreePathForBranch,
} from "./ids.ts";

export interface HerdrControl {
  ping(): Promise<PongResult>;
  snapshot(): Promise<SessionSnapshot>;
  worktreeList(params: { workspace_id?: string; cwd?: string }): Promise<{
    type: "worktree_list";
    source: { repo_root: string; source_workspace_id?: string };
    worktrees: WorktreeInfo[];
  }>;
  worktreeCreate(params: {
    workspace_id: string;
    branch: string;
    base?: string;
    path?: string;
    label?: string;
    focus?: boolean;
  }): Promise<{
    type: "worktree_created";
    workspace: WorkspaceInfo;
    tab: TabInfo;
    root_pane: PaneInfo;
    worktree: WorktreeInfo;
  }>;
  agentStart(params: {
    name: string;
    kind: string;
    pane_id: string;
    args?: string[];
    timeout_ms?: number;
  }): Promise<{ type: "agent_started"; agent: AgentInfo; argv: string[] }>;
  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }>;
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
  }>;
}

export type FailpointName =
  | "before_worktree_response_persist"
  | "before_agent_start_response_persist"
  | "after_prompt_request";

export interface OrchestratorOptions {
  sheltieExecutable: string;
  agentKind?: string;
  worktreeRoot?: string;
  maxDepth?: number;
  maxChildren?: number;
  maxDescendants?: number;
  agentReadyTimeoutMs?: number;
  failpoint?: (name: FailpointName, operationId: string) => void | Promise<void>;
}

export class RuntimeReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeReconcileError";
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sessionValue(agent: AgentInfo): string | null {
  return agent.agent_session?.value ?? null;
}

function instanceValue(agent: AgentInfo): string {
  if (agent.agent_instance_id === undefined) {
    throw new Error(`Herdr agent ${agent.name ?? agent.pane_id} has no instance identity`);
  }
  return agent.agent_instance_id;
}

function resultChildNodeId(operation: OperationRecord): string | null {
  if (operation.result === null || typeof operation.result !== "object") return null;
  const childNodeId = (operation.result as Record<string, unknown>).childNodeId;
  return typeof childNodeId === "string" ? childNodeId : null;
}

export class SheltieOrchestrator {
  private readonly agentKind: string;
  private readonly maxDepth: number;
  private readonly maxChildren: number;
  private readonly maxDescendants: number;
  private readonly agentReadyTimeoutMs: number;

  constructor(
    private readonly store: SheltieStore,
    private readonly herdr: HerdrControl,
    private readonly options: OrchestratorOptions,
  ) {
    this.agentKind = options.agentKind ?? "omp";
    this.maxDepth = options.maxDepth ?? 2;
    this.maxChildren = options.maxChildren ?? 5;
    this.maxDescendants = options.maxDescendants ?? 10;
    this.agentReadyTimeoutMs = options.agentReadyTimeoutMs ?? 60_000;
  }

  async verifyRuntime(): Promise<PongResult> {
    const pong = await this.herdr.ping();
    if (pong.version !== "0.8.0" || pong.protocol !== 20) {
      throw new Error(`unsupported Herdr runtime ${pong.version}/protocol-${pong.protocol}; expected 0.8.0/20`);
    }
    return pong;
  }

  async reserveChild(input: {
    parentPaneId: string;
    requestKey: string;
    name: string;
    taskContract: string;
  }): Promise<NodeRecord> {
    const parent = this.store.findNodeByPane(input.parentPaneId);
    if (parent === null) throw new Error(`no sheltie node is bound to pane ${input.parentPaneId}`);
    const request = { parentNodeId: parent.nodeId, name: input.name, taskContract: input.taskContract };
    const operation = this.store.reserveOperation({
      operationId: operationIdForRequest(parent.treeId, "spawn", input.requestKey),
      treeId: parent.treeId,
      nodeId: parent.nodeId,
      kind: "spawn",
      requestKey: input.requestKey,
      requestHash: requestHash(request),
      request,
    });
    const existingChildNodeId = resultChildNodeId(operation);
    if (existingChildNodeId !== null) return this.store.getNode(existingChildNodeId);

    const baseCommit = await resolveCommit(parent.worktreePath, "HEAD");
    const branch = branchForNode(parent.branch, input.name);
    const nodeId = nodeIdForRequest(parent.treeId, input.requestKey);
    const child = this.store.reserveChildNode(
      {
        nodeId,
        treeId: parent.treeId,
        parentNodeId: parent.nodeId,
        name: input.name,
        depth: parent.depth + 1,
        branch,
        baseCommit,
        worktreePath: worktreePathForBranch(this.options.worktreeRoot ?? dirname(parent.worktreePath), branch),
        taskContract: input.taskContract,
      },
      {
        maxDepth: this.maxDepth,
        maxChildren: this.maxChildren,
        maxDescendants: this.maxDescendants,
      },
    );
    this.store.setOperationStatus(operation.operationId, "completed", { result: { childNodeId: child.nodeId } });
    return child;
  }

  async provisionNode(nodeId: string): Promise<NodeRecord> {
    let node = this.store.getNode(nodeId);
    const tree = this.store.getTree(node.treeId);
    if (tree.status !== "active") {
      throw new Error(`tree ${tree.treeId} is not active (${tree.status})`);
    }
    if (tree.repoSourceWorkspaceId === null) {
      throw new Error(`tree ${tree.treeId} has no repository source workspace`);
    }
    if (node.workspaceId === null || node.paneId === null || node.tabId === null) {
      const request = {
        workspace_id: tree.repoSourceWorkspaceId,
        branch: node.branch,
        base: node.baseCommit,
        path: node.worktreePath,
        label: node.name,
        focus: false,
      };
      const operation = this.store.reserveOperation({
        operationId: operationIdForRequest(node.treeId, "worktree_create", node.nodeId),
        treeId: node.treeId,
        nodeId: node.nodeId,
        kind: "worktree_create",
        requestKey: node.nodeId,
        requestHash: requestHash(request),
        request,
      });
      if (operation.status !== "completed") {
        this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
        try {
          const created = await this.herdr.worktreeCreate(request);
          await this.options.failpoint?.("before_worktree_response_persist", operation.operationId);
          node = this.store.bindWorktree(node.nodeId, {
            workspaceId: created.workspace.workspace_id,
            tabId: created.tab.tab_id,
            paneId: created.root_pane.pane_id,
          });
          this.store.setOperationStatus(operation.operationId, "completed", { result: created });
        } catch (error) {
          this.store.setOperationStatus(operation.operationId, "delivery_unknown", {
            lastError: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      } else {
        node = await this.reconcileNode(node.nodeId);
      }
    }

    if (node.agentName === null) {
      if (node.paneId === null) throw new Error(`node ${node.nodeId} has no pane after worktree provisioning`);
      const name = agentNameForNode(node.nodeId);
      const request = { name, kind: this.agentKind, pane_id: node.paneId, args: [] as string[], timeout_ms: 60_000 };
      const operation = this.store.reserveOperation({
        operationId: operationIdForRequest(node.treeId, "agent_start", node.nodeId),
        treeId: node.treeId,
        nodeId: node.nodeId,
        kind: "agent_start",
        requestKey: node.nodeId,
        requestHash: requestHash(request),
        request,
      });
      if (operation.status !== "completed") {
        this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
        try {
          await this.startAgentWhenShellReady(request);
          const ready = await this.waitForAgentReady(name);
          await this.options.failpoint?.("before_agent_start_response_persist", operation.operationId);
          node = this.store.bindAgent(node.nodeId, {
            agentName: name,
            agentSession: sessionValue(ready),
            terminalId: ready.terminal_id,
            agentInstanceId: instanceValue(ready),
          });
          this.store.setOperationStatus(operation.operationId, "completed", { result: ready });
        } catch (error) {
          this.store.setOperationStatus(operation.operationId, "delivery_unknown", {
            lastError: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      } else {
        node = await this.reconcileNode(node.nodeId);
      }
    }
    return node;
  }

  async reconcileNode(nodeId: string): Promise<NodeRecord> {
    let node = this.store.getNode(nodeId);
    const tree = this.store.getTree(node.treeId);
    if (tree.repoSourceWorkspaceId === null) {
      throw new Error(`tree ${tree.treeId} has no repository source workspace`);
    }
    const [listed, snapshot] = await Promise.all([
      this.herdr.worktreeList({ workspace_id: tree.repoSourceWorkspaceId }),
      this.herdr.snapshot(),
    ]);
    const worktreeMatches = listed.worktrees.filter(
      (worktree) => worktree.path === node.worktreePath && worktree.branch === node.branch && !worktree.is_prunable,
    );
    if (worktreeMatches.length !== 1) {
      throw new RuntimeReconcileError(
        `node ${node.nodeId} expected one worktree at ${node.worktreePath}; found ${worktreeMatches.length}`,
      );
    }
    const worktree = worktreeMatches[0];
    if (worktree === undefined || worktree.open_workspace_id === undefined) {
      throw new RuntimeReconcileError(`node ${node.nodeId} worktree is not open in a Herdr workspace`);
    }
    const workspaceId = worktree.open_workspace_id;
    const panes = snapshot.panes.filter((candidate) => candidate.workspace_id === workspaceId);
    const expectedAgentName = agentNameForNode(node.nodeId);
    const agents = snapshot.agents.filter(
      (candidate) => candidate.workspace_id === workspaceId && candidate.name === expectedAgentName,
    );
    if (agents.length > 1) {
      throw new RuntimeReconcileError(`node ${node.nodeId} has duplicate agent name ${expectedAgentName}`);
    }
    const selectedPane = agents[0] === undefined
      ? panes.length === 1
        ? panes[0]
        : panes.find((candidate) => candidate.pane_id === node.paneId)
      : panes.find((candidate) => candidate.pane_id === agents[0]?.pane_id);
    if (selectedPane === undefined) {
      throw new RuntimeReconcileError(`node ${node.nodeId} has no unique pane in workspace ${workspaceId}`);
    }
    node = this.store.bindWorktree(node.nodeId, {
      workspaceId,
      tabId: selectedPane.tab_id,
      paneId: selectedPane.pane_id,
    });
    const worktreeOperation = this.store.findOperation(
      operationIdForRequest(node.treeId, "worktree_create", node.nodeId),
    );
    if (worktreeOperation !== null && worktreeOperation.status !== "completed") {
      this.store.setOperationStatus(worktreeOperation.operationId, "completed", {
        result: { reconciled: true, workspaceId, paneId: selectedPane.pane_id },
      });
    }
    const selectedAgent = agents[0];
    if (selectedAgent !== undefined) {
      node = this.store.bindAgent(node.nodeId, {
        agentName: expectedAgentName,
        agentSession: sessionValue(selectedAgent),
        terminalId: selectedAgent.terminal_id,
        agentInstanceId: instanceValue(selectedAgent),
      });
      const agentOperation = this.store.findOperation(
        operationIdForRequest(node.treeId, "agent_start", node.nodeId),
      );
      if (agentOperation !== null && agentOperation.status !== "completed") {
        this.store.setOperationStatus(agentOperation.operationId, "completed", {
          result: { reconciled: true, agentName: expectedAgentName, paneId: selectedAgent.pane_id },
        });
      }
    }
    return node;
  }

  async dispatchStep(nodeId: string, stepKey: string, taskContract: string): Promise<OperationRecord> {
    const node = this.store.getNode(nodeId);
    const tree = this.store.getTree(node.treeId);
    if (tree.status !== "active") {
      throw new Error(`tree ${tree.treeId} is not active (${tree.status})`);
    }
    if (node.agentName === null || node.paneId === null) {
      throw new Error(`node ${node.nodeId} is not ready for a prompt`);
    }
    const requestKey = `${node.nodeId}/step/${stepKey}`;
    const operationId = operationIdForRequest(node.treeId, "prompt", requestKey);
    const prompt = this.buildStepPrompt(node, operationId, taskContract);
    const promptSha256 = requestHash(prompt);
    let operation = this.store.reserveOperation({
      operationId,
      treeId: node.treeId,
      nodeId: node.nodeId,
      kind: "prompt",
      requestKey,
      requestHash: requestHash({ promptSha256, target: node.agentName }),
      request: { promptSha256, target: node.agentName },
    });
    if (
      operation.status !== "reserved" &&
      operation.status !== "submitted" &&
      operation.status !== "delivery_unknown"
    ) {
      return operation;
    }
    this.store.reserveStep({
      operationId,
      nodeId: node.nodeId,
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256,
    });
    operation = this.store.setOperationStatus(operationId, "submitted", { incrementAttempt: true });
    try {
      const prompted = await this.herdr.agentPrompt({
        target: node.agentName,
        text: prompt,
        client_operation_id: operationId,
      });
      await this.options.failpoint?.("after_prompt_request", operationId);
      this.store.setNodeLifecycle(node.nodeId, "running");
      return this.store.setOperationStatus(operationId, "observed", { result: prompted });
    } catch (error) {
      return this.store.setOperationStatus(operationId, "delivery_unknown", {
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async processPendingNodes(treeId: string): Promise<NodeRecord[]> {
    const processed: NodeRecord[] = [];
    for (const candidate of this.store.listNodes(treeId)) {
      if (candidate.agentName !== null || candidate.lifecycleStatus === "completed") continue;
      const provisioned = await this.provisionNode(candidate.nodeId);
      await this.dispatchStep(provisioned.nodeId, "initial", provisioned.taskContract);
      processed.push(this.store.getNode(provisioned.nodeId));
    }
    return processed;
  }

  private async startAgentWhenShellReady(request: {
    name: string;
    kind: string;
    pane_id: string;
    args?: string[];
    timeout_ms?: number;
  }): Promise<void> {
    const deadline = Date.now() + this.agentReadyTimeoutMs;
    let lastBusyError: HerdrApiError | null = null;
    while (Date.now() < deadline) {
      try {
        await this.herdr.agentStart(request);
        return;
      } catch (error) {
        if (!(error instanceof HerdrApiError) || error.code !== "agent_pane_busy") throw error;
        lastBusyError = error;
        await Bun.sleep(100);
      }
    }
    throw new Error(`agent pane did not become an available shell: ${lastBusyError?.message ?? "unknown"}`);
  }

  private async waitForAgentReady(target: string): Promise<AgentInfo> {
    const deadline = Date.now() + this.agentReadyTimeoutMs;
    let last: AgentInfo | null = null;
    while (Date.now() < deadline) {
      const response = await this.herdr.agentGet(target);
      last = response.agent;
      if (!last.launch_pending && last.interactive_ready) return last;
      await Bun.sleep(100);
    }
    throw new Error(`agent ${target} did not become ready: ${last?.agent_status ?? "unknown"}`);
  }

  private buildStepPrompt(node: NodeRecord, operationId: string, taskContract: string): string {
    const executable = shellQuote(this.options.sheltieExecutable);
    const database = shellQuote(this.store.path);
    const nodeId = shellQuote(node.nodeId);
    const instructions = [
      `You are sheltie node ${node.name} (${node.nodeId}).`,
      "Before changing files or spawning children, run exactly:",
      `${executable} step claim --db ${database} --operation-id ${shellQuote(operationId)} --agent-session \"$HERDR_PANE_ID\"`,
      "Continue only when the JSON outcome is claimed. Stop without work for already_claimed, completed, or conflict.",
      "",
      "Task contract:",
      taskContract,
      "",
      "To wait up to three minutes for unread child results, run:",
      `${executable} sync --db ${database} --node-id ${nodeId} --wait-ms 180000`,
      "After a child reports completion, merge its committed result from this parent worktree with:",
      `${executable} merge --db ${database} --parent-pane \"$HERDR_PANE_ID\" --child-node <child-node-id>`,
      "Use the childNodeId returned by spawn. Merge every direct child before finishing this node.",
    ];
    if (node.parentNodeId !== null) {
      instructions.push(
        "To send a result to the parent, use this command with a concrete result body:",
        `${executable} message send --db ${database} --from ${nodeId} --to ${shellQuote(node.parentNodeId)} --body \"<result>\"`,
      );
    }
    instructions.push(
      "",
      "Commit every change on the current branch. Then complete this step with:",
      `${executable} step complete --db ${database} --operation-id ${shellQuote(operationId)} --agent-session \"$HERDR_PANE_ID\" --commit \"$(git rev-parse HEAD)\"`,
      "After every spawned child has completed and its result has been handled, finish this node with:",
      `${executable} node finish --db ${database} --node-id ${nodeId} --agent-session \"$HERDR_PANE_ID\"`,
      "Never finish the node while a child or step is incomplete.",
    );
    return instructions.join("\n");
  }
}


