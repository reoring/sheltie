import { dirname } from "node:path";
import type { NodePlacement, NodeRecord, NodeSpawnPolicy, OperationRecord, TreeRecord } from "./db.ts";
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
import {
  getManifestRole,
  parseResolvedManifest,
  resolveRoleParameters,
  type ResolvedManifestRole,
  type ResolvedRunManifest,
  spawnPolicyForRole,
} from "./manifest.ts";
import { defaultOkfCompactionExtensionPath, prepareOkfCompactionRuntime } from "./okf-compaction-runtime.ts";

export interface HerdrControl {
  ping(): Promise<PongResult>;
  snapshot(): Promise<SessionSnapshot>;
  workspaceCreate(params: {
    cwd: string;
    focus?: boolean;
    label?: string;
    env?: Record<string, string>;
  }): Promise<{ type: "workspace_created"; workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }>;
  worktreeList(params: { workspace_id?: string; cwd?: string }): Promise<{
    type: "worktree_list";
    source: { repo_root: string; source_workspace_id?: string };
    worktrees: WorktreeInfo[];
  }>;
  worktreeCreate(params: {
    workspace_id?: string;
    cwd?: string;
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
  tabCreate(params: {
    workspace_id: string;
    cwd?: string;
    focus?: boolean;
    label?: string;
    env?: Record<string, string>;
  }): Promise<{ type: "tab_created"; tab: TabInfo; root_pane: PaneInfo }>;
  tabRename(params: { tab_id: string; label: string }): Promise<{ type: "tab_info"; tab: TabInfo }>;
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
  | "before_tab_response_persist"
  | "before_agent_start_response_persist"
  | "after_prompt_request";

export interface OrchestratorOptions {
  sheltieExecutable: string;
  agentKind?: string;
  worktreeRoot?: string;
  workspaceEnvironment?: Record<string, string>;
  maxDepth?: number;
  maxChildren?: number;
  maxDescendants?: number;
  agentReadyTimeoutMs?: number;
  failpoint?: (name: FailpointName, operationId: string) => void | Promise<void>;
  okfCompactionExtensionPath?: string;
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

function tabLabelForNode(node: NodeRecord): string {
  return `${node.name}-${node.nodeId.slice(-8)}`;
}

export function rootWorkspaceLabel(nodeId: string): string {
  return nodeId;
}

function allowsSpawn(policy: NodeSpawnPolicy, placement: NodePlacement): boolean {
  return policy === "both" || policy === placement;
}

function instanceValue(agent: AgentInfo): string {
  if (typeof agent.agent_instance_id !== "string" || agent.agent_instance_id.length === 0) {
    throw new RuntimeReconcileError(`Agent ${agent.name ?? agent.pane_id} has no protocol-20 per-launch instance identity`);
  }
  return agent.agent_instance_id;
}

function resultChildNodeId(operation: OperationRecord): string | null {
  if (operation.result === null || typeof operation.result !== "object") return null;
  const childNodeId = (operation.result as Record<string, unknown>).childNodeId;
  return typeof childNodeId === "string" ? childNodeId : null;
}

function requestWithRuntimeBinding<T extends Record<string, unknown>>(
  tree: TreeRecord,
  request: T,
): T | (T & { runtimeBinding: TreeRecord["runtimeBinding"] }) {
  return tree.runtimeBinding.mode === "external" ? request : { ...request, runtimeBinding: tree.runtimeBinding };
}

export class SheltieOrchestrator {
  private readonly agentKind: string;
  private readonly agentReadyTimeoutMs: number;

  constructor(
    private readonly store: SheltieStore,
    private readonly herdr: HerdrControl,
    private readonly options: OrchestratorOptions,
  ) {
    this.agentKind = options.agentKind ?? "omp";
    this.agentReadyTimeoutMs = options.agentReadyTimeoutMs ?? 60_000;
  }

  async verifyRuntime(): Promise<PongResult> {
    const pong = await this.herdr.ping();
    if (pong.version !== "0.8.0" || pong.protocol !== 20) {
      throw new Error(`unsupported Herdr runtime ${pong.version}/protocol-${pong.protocol}; expected 0.8.0/20`);
    }
    return pong;
  }

  private manifestForTree(tree: TreeRecord): ResolvedRunManifest | null {
    if (tree.manifestDigest === null) return null;
    const record = this.store.getManifest(tree.manifestDigest);
    if (record === null) throw new Error(`tree ${tree.treeId} manifest ${tree.manifestDigest} is missing`);
    return parseResolvedManifest(record.resolved);
  }

  private roleForNode(node: NodeRecord, tree: TreeRecord): ResolvedManifestRole | null {
    if (node.roleName === null) return null;
    const manifest = this.manifestForTree(tree);
    if (manifest === null) throw new Error(`node ${node.nodeId} has role ${node.roleName} without a manifest`);
    const role = getManifestRole(manifest, node.roleName);
    if (node.roleDigest !== role.digest) {
      throw new Error(`node ${node.nodeId} role digest does not match manifest role ${node.roleName}`);
    }
    return role;
  }

  async reserveChild(input: {
    parentPaneId: string;
    requestKey: string;
    name: string;
    roleName: string;
    parameters?: unknown;
  }): Promise<NodeRecord> {
    const parent = this.store.findNodeByPane(input.parentPaneId);
    if (parent === null) throw new Error(`no sheltie node is bound to pane ${input.parentPaneId}`);
    const tree = this.store.getTree(parent.treeId);
    const manifest = this.manifestForTree(tree);
    if (manifest === null || parent.roleName === null) {
      throw new Error(`node ${parent.nodeId} is not bound to a manifest role`);
    }
    const parentRole = getManifestRole(manifest, parent.roleName);
    if (!parentRole.capabilities.spawn.roles.includes(input.roleName)) {
      throw new Error(`role ${parentRole.name} cannot spawn role ${input.roleName}`);
    }
    const childRole = getManifestRole(manifest, input.roleName);
    const parameters = resolveRoleParameters(childRole, input.parameters);
    const nodeId = nodeIdForRequest(parent.treeId, input.requestKey);
    const existingSibling = this.store.findChildNode(parent.nodeId, input.name);
    if (existingSibling !== null && existingSibling.nodeId !== nodeId) {
      throw new Error(
        `child name ${input.name} is already reserved by a different request under ${parent.nodeId}`,
      );
    }
    const request = {
      manifestDigest: tree.manifestDigest,
      parentNodeId: parent.nodeId,
      parentRole: parentRole.name,
      name: input.name,
      targetRole: childRole.name,
      roleDigest: childRole.digest,
      parameters,
    };
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
    const branch = childRole.placement === "workspace" ? branchForNode(parent.branch, input.name) : parent.branch;
    const maxChildren = Math.min(
      manifest.spec.limits.maxChildrenPerNode,
      parentRole.capabilities.spawn.maxChildren ?? manifest.spec.limits.maxChildrenPerNode,
    );
    const child = this.store.reserveChildNode(
      {
        nodeId,
        treeId: parent.treeId,
        parentNodeId: parent.nodeId,
        name: input.name,
        depth: parent.depth + 1,
        placement: childRole.placement,
        branch,
        baseCommit,
        spawnPolicy: spawnPolicyForRole(manifest, childRole),
        worktreePath:
          childRole.placement === "workspace"
            ? worktreePathForBranch(this.options.worktreeRoot ?? dirname(parent.worktreePath), branch)
            : parent.worktreePath,
        taskContract: childRole.prompt.content,
        roleName: childRole.name,
        roleDigest: childRole.digest,
        parameters,
        resolvedCapabilities: childRole.capabilities,
      },
      {
        maxDepth: manifest.spec.limits.maxDepth,
        maxChildren,
        maxDescendants: manifest.spec.limits.maxDescendants,
      },
    );
    this.store.setOperationStatus(operation.operationId, "completed", {
      result: {
        childNodeId: child.nodeId,
        role: childRole.name,
        placement: child.placement,
        spawnPolicy: child.spawnPolicy,
      },
    });
    return child;
  }

  async provisionNode(nodeId: string): Promise<NodeRecord> {
    let node = this.store.getNode(nodeId);
    const tree = this.store.getTree(node.treeId);
    if (tree.status !== "active") {
      throw new Error(`tree ${tree.treeId} is not active (${tree.status})`);
    }
    if (node.workspaceId === null || node.paneId === null || node.tabId === null) {
      node =
        node.parentNodeId === null && node.worktreePath === tree.repoRoot
          ? await this.provisionRootWorkspace(node, tree)
          : node.placement === "tab"
            ? await this.provisionTabRuntime(node, tree)
            : await this.provisionWorkspaceRuntime(node, tree);
    }

    if (node.agentName === null) {
      if (node.paneId === null) throw new Error(`node ${node.nodeId} has no pane after worktree provisioning`);
      const name = agentNameForNode(node.nodeId);
      const role = this.roleForNode(node, tree);
      const compactionPolicy = role === null ? undefined : this.manifestForTree(tree)?.spec.knowledge?.compaction;
      const compactionRuntime =
        role !== null && compactionPolicy !== undefined && compactionPolicy.roles.includes(role.name)
          ? prepareOkfCompactionRuntime({
            stateDatabasePath: this.store.path,
            treeId: node.treeId,
            nodeId: node.nodeId,
            thresholdPercent: compactionPolicy.thresholdPercent,
            extensionPath:
              this.options.okfCompactionExtensionPath ?? defaultOkfCompactionExtensionPath(this.options.sheltieExecutable),
          })
          : null;
      const request = {
        name,
        kind: role?.agent.kind ?? this.agentKind,
        pane_id: node.paneId,
        args:
          compactionRuntime === null
            ? (role?.agent.args ?? [])
            : [
              "--config",
              compactionRuntime.configPath,
              "--extension",
              compactionRuntime.extensionPath,
              "--sheltie-okf-dir",
              compactionRuntime.outputDirectory,
              "--sheltie-okf-role",
              role!.name,
              ...role!.agent.args,
            ],
        timeout_ms: 60_000,
      };
      const operationRequest = requestWithRuntimeBinding(tree, request);
      const operation = this.store.reserveOperation({
        operationId: operationIdForRequest(node.treeId, "agent_start", node.nodeId),
        treeId: node.treeId,
        nodeId: node.nodeId,
        kind: "agent_start",
        requestKey: node.nodeId,
        requestHash: requestHash(operationRequest),
        request: operationRequest,
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

  private async provisionRootWorkspace(node: NodeRecord, tree: TreeRecord): Promise<NodeRecord> {
    const request = {
      cwd: tree.repoRoot,
      focus: false,
      label: rootWorkspaceLabel(node.nodeId),
      env: {
        ...this.options.workspaceEnvironment,
        SHELTIE_RUN_ID: tree.runId,
        SHELTIE_NODE_ID: node.nodeId,
      },
    };
    const operationRequest = requestWithRuntimeBinding(tree, request);
    let operation = this.store.reserveOperation({
      operationId: operationIdForRequest(node.treeId, "workspace_create", node.nodeId),
      treeId: node.treeId,
      nodeId: node.nodeId,
      kind: "workspace_create",
      requestKey: node.nodeId,
      requestHash: requestHash(operationRequest),
      request: operationRequest,
    });
    if (operation.status === "completed") return this.reconcileNode(node.nodeId);
    if (operation.status !== "reserved") return this.reconcileNode(node.nodeId);
    operation = this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
    try {
      const created = await this.herdr.workspaceCreate(request);
      await this.herdr.tabRename({ tab_id: created.tab.tab_id, label: "coord" });
      await this.options.failpoint?.("before_worktree_response_persist", operation.operationId);
      const bound = this.store.bindWorktree(node.nodeId, {
        workspaceId: created.workspace.workspace_id,
        tabId: created.tab.tab_id,
        paneId: created.root_pane.pane_id,
      });
      this.store.bindRepoSourceWorkspace(tree.treeId, created.workspace.workspace_id);
      this.store.setOperationStatus(operation.operationId, "completed", { result: created });
      return bound;
    } catch (error) {
      this.store.setOperationStatus(operation.operationId, "delivery_unknown", {
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async provisionWorkspaceRuntime(node: NodeRecord, tree: TreeRecord): Promise<NodeRecord> {
    const source =
      tree.repoSourceWorkspaceId === null
        ? { cwd: tree.repoRoot }
        : { workspace_id: tree.repoSourceWorkspaceId };
    const request = {
      ...source,
      branch: node.branch,
      base: node.baseCommit,
      path: node.worktreePath,
      label: node.name,
      focus: false,
    };
    const operationRequest = requestWithRuntimeBinding(tree, request);
    let operation = this.store.reserveOperation({
      operationId: operationIdForRequest(node.treeId, "worktree_create", node.nodeId),
      treeId: node.treeId,
      nodeId: node.nodeId,
      kind: "worktree_create",
      requestKey: node.nodeId,
      requestHash: requestHash(operationRequest),
      request: operationRequest,
    });
    if (operation.status === "completed") return this.reconcileNode(node.nodeId);
    if (operation.status !== "reserved") return this.reconcileNode(node.nodeId);
    operation = this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
    try {
      const created = await this.herdr.worktreeCreate(request);
      await this.herdr.tabRename({ tab_id: created.tab.tab_id, label: "coord" });
      await this.options.failpoint?.("before_worktree_response_persist", operation.operationId);
      const bound = this.store.bindWorktree(node.nodeId, {
        workspaceId: created.workspace.workspace_id,
        tabId: created.tab.tab_id,
        paneId: created.root_pane.pane_id,
      });
      this.store.setOperationStatus(operation.operationId, "completed", { result: created });
      return bound;
    } catch (error) {
      this.store.setOperationStatus(operation.operationId, "delivery_unknown", {
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async provisionTabRuntime(node: NodeRecord, tree: TreeRecord): Promise<NodeRecord> {
    if (node.parentNodeId === null) throw new Error(`tab node ${node.nodeId} has no parent`);
    const parent = this.store.getNode(node.parentNodeId);
    if (parent.workspaceId === null) {
      throw new Error(`tab node ${node.nodeId} parent ${parent.nodeId} has no workspace`);
    }
    const request = {
      workspace_id: parent.workspaceId,
      cwd: node.worktreePath,
      focus: false,
      label: tabLabelForNode(node),
      env: {
        ...this.options.workspaceEnvironment,
        SHELTIE_RUN_ID: tree.runId,
        SHELTIE_NODE_ID: node.nodeId,
        SHELTIE_PARENT_NODE_ID: parent.nodeId,
      },
    };
    const operationRequest = requestWithRuntimeBinding(tree, request);
    let operation = this.store.reserveOperation({
      operationId: operationIdForRequest(node.treeId, "tab_create", node.nodeId),
      treeId: node.treeId,
      nodeId: node.nodeId,
      kind: "tab_create",
      requestKey: node.nodeId,
      requestHash: requestHash(operationRequest),
      request: operationRequest,
    });
    if (operation.status === "completed") return this.reconcileNode(node.nodeId);
    if (operation.status !== "reserved") return this.reconcileNode(node.nodeId);
    operation = this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
    try {
      const created = await this.herdr.tabCreate(request);
      await this.options.failpoint?.("before_tab_response_persist", operation.operationId);
      const bound = this.store.bindWorktree(node.nodeId, {
        workspaceId: created.tab.workspace_id,
        tabId: created.tab.tab_id,
        paneId: created.root_pane.pane_id,
      });
      this.store.setOperationStatus(operation.operationId, "completed", { result: created });
      return bound;
    } catch (error) {
      this.store.setOperationStatus(operation.operationId, "delivery_unknown", {
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async reconcileNode(nodeId: string): Promise<NodeRecord> {
    let node = this.store.getNode(nodeId);
    const tree = this.store.getTree(node.treeId);
    if (node.parentNodeId === null && node.worktreePath === tree.repoRoot) {
      return this.reconcileRootWorkspace(node, tree);
    }
    if (node.placement === "tab") return this.reconcileTabNode(node);
    const source =
      tree.repoSourceWorkspaceId === null
        ? { cwd: tree.repoRoot }
        : { workspace_id: tree.repoSourceWorkspaceId };
    const [listed, snapshot] = await Promise.all([
      this.herdr.worktreeList(source),
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
    const selectedTab = snapshot.tabs.find((tab) => tab.tab_id === selectedPane.tab_id);
    if (selectedTab === undefined) {
      throw new RuntimeReconcileError(`workspace ${workspaceId} pane ${selectedPane.pane_id} has no tab`);
    }
    if (selectedTab.label !== "coord") {
      await this.herdr.tabRename({ tab_id: selectedTab.tab_id, label: "coord" });
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

  private async reconcileRootWorkspace(node: NodeRecord, tree: TreeRecord): Promise<NodeRecord> {
    const snapshot = await this.herdr.snapshot();
    const matches = snapshot.workspaces.filter(
      (workspace) =>
        workspace.label === rootWorkspaceLabel(node.nodeId) &&
        (tree.repoSourceWorkspaceId === null || workspace.workspace_id === tree.repoSourceWorkspaceId) &&
        workspace.worktree?.checkout_path === tree.repoRoot &&
        !workspace.worktree.is_linked_worktree,
    );
    if (matches.length !== 1) {
      throw new RuntimeReconcileError(
        `root node ${node.nodeId} expected one repository workspace; found ${matches.length}`,
      );
    }
    const workspace = matches[0];
    if (workspace === undefined) throw new RuntimeReconcileError(`root node ${node.nodeId} lost its workspace`);
    const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
    const tab = node.tabId === null
      ? tabs.find((candidate) => candidate.label === "coord") ?? (tabs.length === 1 ? tabs[0] : undefined)
      : tabs.find((candidate) => candidate.tab_id === node.tabId);
    if (tab === undefined) {
      throw new RuntimeReconcileError(`root workspace ${workspace.workspace_id} has no unique coordinator tab`);
    }
    if (tab.label !== "coord") await this.herdr.tabRename({ tab_id: tab.tab_id, label: "coord" });
    const panes = snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id);
    if (panes.length !== 1) {
      throw new RuntimeReconcileError(`root coordinator tab ${tab.tab_id} expected one pane; found ${panes.length}`);
    }
    const pane = panes[0];
    if (pane === undefined) throw new RuntimeReconcileError(`root coordinator tab ${tab.tab_id} has no pane`);
    let rebound = this.store.bindWorktree(node.nodeId, {
      workspaceId: workspace.workspace_id,
      tabId: tab.tab_id,
      paneId: pane.pane_id,
    });
    if (tree.repoSourceWorkspaceId === null) {
      this.store.bindRepoSourceWorkspace(tree.treeId, workspace.workspace_id);
    }
    const workspaceOperation = this.store.findOperation(
      operationIdForRequest(node.treeId, "workspace_create", node.nodeId),
    );
    if (workspaceOperation !== null && workspaceOperation.status !== "completed") {
      this.store.setOperationStatus(workspaceOperation.operationId, "completed", {
        result: { reconciled: true, workspaceId: workspace.workspace_id, tabId: tab.tab_id, paneId: pane.pane_id },
        lastError: null,
      });
    }
    const expectedAgentName = agentNameForNode(node.nodeId);
    const agents = snapshot.agents.filter(
      (agent) => agent.name === expectedAgentName && agent.pane_id === pane.pane_id,
    );
    if (agents.length > 1) {
      throw new RuntimeReconcileError(`root node ${node.nodeId} has duplicate agent ${expectedAgentName}`);
    }
    const selectedAgent = agents[0];
    if (selectedAgent !== undefined) {
      rebound = this.store.bindAgent(node.nodeId, {
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
          lastError: null,
        });
      }
    }
    return rebound;
  }

  private async reconcileTabNode(node: NodeRecord): Promise<NodeRecord> {
    if (node.parentNodeId === null) throw new RuntimeReconcileError(`tab node ${node.nodeId} has no parent`);
    const parent = this.store.getNode(node.parentNodeId);
    if (parent.workspaceId === null) {
      throw new RuntimeReconcileError(`tab node ${node.nodeId} parent ${parent.nodeId} has no workspace`);
    }
    const snapshot = await this.herdr.snapshot();
    const tabMatches = snapshot.tabs.filter(
      (tab) =>
        tab.workspace_id === parent.workspaceId &&
        (node.tabId === null ? tab.label === tabLabelForNode(node) : tab.tab_id === node.tabId),
    );
    if (tabMatches.length !== 1) {
      throw new RuntimeReconcileError(
        `tab node ${node.nodeId} expected one tab ${tabLabelForNode(node)} in ${parent.workspaceId}; found ${tabMatches.length}`,
      );
    }
    const tab = tabMatches[0];
    if (tab === undefined) throw new RuntimeReconcileError(`tab node ${node.nodeId} lost its tab match`);
    const panes = snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id);
    if (panes.length !== 1) {
      throw new RuntimeReconcileError(`tab ${tab.tab_id} expected one root pane; found ${panes.length}`);
    }
    const selectedPane = panes[0];
    if (selectedPane === undefined) throw new RuntimeReconcileError(`tab ${tab.tab_id} has no root pane`);
    if (selectedPane.cwd !== undefined && selectedPane.cwd !== node.worktreePath) {
      throw new RuntimeReconcileError(
        `tab ${tab.tab_id} cwd ${selectedPane.cwd} differs from shared worktree ${node.worktreePath}`,
      );
    }
    let rebound = this.store.bindWorktree(node.nodeId, {
      workspaceId: parent.workspaceId,
      tabId: tab.tab_id,
      paneId: selectedPane.pane_id,
    });
    const tabOperation = this.store.findOperation(
      operationIdForRequest(node.treeId, "tab_create", node.nodeId),
    );
    if (tabOperation !== null && tabOperation.status !== "completed") {
      this.store.setOperationStatus(tabOperation.operationId, "completed", {
        result: { reconciled: true, workspaceId: parent.workspaceId, tabId: tab.tab_id, paneId: selectedPane.pane_id },
        lastError: null,
      });
    }
    const expectedAgentName = agentNameForNode(node.nodeId);
    const agents = snapshot.agents.filter(
      (agent) => agent.name === expectedAgentName && agent.pane_id === selectedPane.pane_id,
    );
    if (agents.length > 1) {
      throw new RuntimeReconcileError(`tab node ${node.nodeId} has duplicate agent ${expectedAgentName}`);
    }
    const selectedAgent = agents[0];
    if (selectedAgent !== undefined) {
      rebound = this.store.bindAgent(node.nodeId, {
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
          lastError: null,
        });
      }
    }
    return rebound;
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
    const request = { promptSha256, target: node.agentName };
    const operationRequest = requestWithRuntimeBinding(tree, request);
    let operation = this.store.reserveOperation({
      operationId,
      treeId: node.treeId,
      nodeId: node.nodeId,
      kind: "prompt",
      requestKey,
      requestHash: requestHash(operationRequest),
      request: operationRequest,
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
    const tree = this.store.getTree(treeId);
    const manifest = this.manifestForTree(tree);
    const nodes = this.store.listNodes(treeId);
    const terminal = new Set(["completed", "failed", "cancelled", "cancel_blocked"]);
    let active = nodes.filter((node) => node.agentName !== null && !terminal.has(node.lifecycleStatus)).length;
    const maxParallel = manifest?.spec.limits.maxParallelNodes ?? Number.POSITIVE_INFINITY;
    for (const candidate of nodes) {
      if (candidate.agentName !== null || terminal.has(candidate.lifecycleStatus)) continue;
      if (active >= maxParallel) break;
      const provisioned = await this.provisionNode(candidate.nodeId);
      await this.dispatchStep(provisioned.nodeId, "initial", provisioned.taskContract);
      processed.push(this.store.getNode(provisioned.nodeId));
      active += 1;
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
    const tree = this.store.getTree(node.treeId);
    const manifest = this.manifestForTree(tree);
    const role = this.roleForNode(node, tree);
    const roleLabel = role === null ? "legacy" : role.name;
    const instructions = [
      `You are sheltie ${node.placement} node ${node.name} (${node.nodeId}), role ${roleLabel}.`,
      "Before changing files or spawning children, run exactly:",
      `${executable} step claim --db ${database} --operation-id ${shellQuote(operationId)} --caller-pane "$HERDR_PANE_ID"`,
      "Continue only when the JSON outcome is claimed. Stop without work for already_claimed, completed, or conflict.",
      "",
      "Task contract:",
      taskContract,
      "",
    ];
    if (role !== null && Object.keys(node.parameters as Record<string, unknown>).length > 0) {
      instructions.push("Role parameters (canonical JSON):", JSON.stringify(node.parameters), "");
    }
    if (manifest !== null && role !== null) {
      if (role.capabilities.spawn.roles.length === 0) {
        instructions.push(
          "Child spawning is not authorized for this role. Do not run sheltie spawn, even if the task text suggests it.",
          "",
        );
      } else {
        instructions.push("Authorized child roles:");
        for (const childRoleName of role.capabilities.spawn.roles) {
          const childRole = getManifestRole(manifest, childRoleName);
          const parameterFlag = Object.keys(childRole.parameters).length === 0
            ? ""
            : " --params-json '<json-object>'";
          instructions.push(
            `- ${childRoleName}: ${childRole.placement} placement`,
            `${executable} spawn --db ${database} --caller-pane "$HERDR_PANE_ID" --request-key <stable-key> --name <name> --role ${shellQuote(childRoleName)}${parameterFlag}`,
          );
        }
        instructions.push("- Spawn only roles listed above. The manifest fixes placement, prompt, Agent kind, and capabilities.", "");
      }
    } else if (node.spawnPolicy === "none") {
      instructions.push(
        "Child spawning is not authorized for this node. Do not run sheltie spawn, even if the task text suggests it.",
        "",
      );
    } else {
      instructions.push("Authorized child topology:");
      if (allowsSpawn(node.spawnPolicy, "workspace")) {
        instructions.push(
          "- Spawn an isolated child space with its own branch/worktree:",
          `${executable} spawn --db ${database} --caller-pane "$HERDR_PANE_ID" --request-key <stable-key> --name <name> --placement workspace --child-spawn-policy none --task "<task>"`,
        );
      }
      if (allowsSpawn(node.spawnPolicy, "tab")) {
        instructions.push(
          "- Spawn a collaborator tab in this same space and shared worktree:",
          `${executable} spawn --db ${database} --caller-pane "$HERDR_PANE_ID" --request-key <stable-key> --name <name> --placement tab --child-spawn-policy none --task "<task>"`,
        );
      }
      instructions.push("");
    }
    instructions.push(
      "Durable inbox:",
      `- Receive unread messages with: ${executable} sync --db ${database} --caller-pane "$HERDR_PANE_ID" --wait-ms 180000`,
      `- Send an ordinary update with: ${executable} message send --db ${database} --caller-pane "$HERDR_PANE_ID" --to <node-id> --kind progress --body "<update>"`,
      "- progress/message != completion: a progress message is not a completion signal.",
      "- Treat only a result-kind message from a completed sender as a completion message.",
      "- Message bodies are stored in SQLite. Herdr prompt is not the message transport.",
    );
    if (role?.capabilities.mergeChildren ?? true) {
      instructions.push(
        "",
        "Merge an authorized workspace child only after its result-kind message arrives from a completed sender:",
        `${executable} merge --db ${database} --caller-pane "$HERDR_PANE_ID" --child-node <child-node-id>`,
        "Do not merge from progress messages; the database rejects result messages until their sender is completed.",
        "Do not merge tab children; they share this branch/worktree. Handle their inbox result and wait for their completion.",
      );
    } else {
      instructions.push("", "This role is not authorized to merge child branches.");
    }
    if (node.placement === "tab") {
      instructions.push(
        "",
        "This tab shares its parent worktree.",
        role?.executionPolicy.workspace === "read-write"
          ? "The manifest permits cooperative read-write work, but coordinate the shared scope before changing files."
          : "The manifest declares this workspace read-only for this role. Do not modify files or create commits.",
        "For research/message-only work, complete the step with the unchanged current HEAD.",
      );
    }
    const stepCompletionCommand =
      `${executable} step complete --db ${database} --operation-id ${shellQuote(operationId)} --caller-pane "$HERDR_PANE_ID" --commit "$(git rev-parse HEAD)"`;
    const nodeFinishCommand =
      `${executable} node finish --db ${database} --node-id ${nodeId} --caller-pane "$HERDR_PANE_ID"`;
    instructions.push("");
    if (node.parentNodeId === null) {
      instructions.push(
        node.placement === "workspace"
          ? "Commit every owned change on the current branch. Then complete this step with:"
          : "After respecting the shared-worktree rule, complete this step with:",
        stepCompletionCommand,
        "After every spawned child has completed and every inbox result has been handled, finish this node with:",
        nodeFinishCommand,
        "Never finish the node while a child or step is incomplete.",
      );
    } else {
      instructions.push(
        "Non-root finalization order:",
        `1. Complete the step: ${stepCompletionCommand}`,
        `2. Finish this node after every spawned child has completed and every inbox result has been handled: ${nodeFinishCommand}`,
        `3. Send the parent the final result: ${executable} message send --db ${database} --caller-pane "$HERDR_PANE_ID" --to ${shellQuote(node.parentNodeId)} --kind result --body "<result>"`,
        "Never finish the node while a child or step is incomplete.",
      );
    }
    return instructions.join("\n");
  }
}


