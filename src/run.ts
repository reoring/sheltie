import { mkdirSync, realpathSync } from "node:fs";
import type { TreeRecord } from "./db.ts";
import { SheltieStore } from "./db.ts";
import { isCleanWorktree, resolveCommit } from "./git.ts";
import type {
  PaneInfo,
  PongResult,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "./herdr-client.ts";
import { branchForNode, nodeIdForRequest, operationIdForRequest, requestHash, worktreePathForBranch } from "./ids.ts";
import { type HerdrControl, SheltieOrchestrator } from "./orchestrator.ts";

const REQUIRED_HERDR_VERSION = "0.8.0";
const REQUIRED_HERDR_PROTOCOL = 20;

export interface RunHerdrControl extends HerdrControl {
  workspaceCreate(params: {
    cwd: string;
    focus?: boolean;
    label?: string;
    env?: Record<string, string>;
  }): Promise<{ type: "workspace_created"; workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }>;
}

export type RealRunFailpoint = "before_source_workspace_response_persist";

export interface RealRunControllerOptions {
  sheltieExecutable: string;
  failpoint?: (name: RealRunFailpoint, operationId: string) => void | Promise<void>;
  onTreeReserved?: (tree: TreeRecord) => void;
}

export interface StartRunInput {
  runId: string;
  repoRoot: string;
  base: string;
  worktreeRoot: string;
  taskContract: string;
  herdrSocketPath: string;
}

export interface RealRunStatus {
  tree: TreeRecord;
  nodes: ReturnType<SheltieStore["listNodes"]>;
  operations: ReturnType<SheltieStore["listUnresolvedOperations"]>;
  steps: ReturnType<SheltieStore["listSteps"]>;
  messages: ReturnType<SheltieStore["listMessages"]>;
}

function runSuffix(runId: string): string {
  return requestHash(runId).slice(0, 12);
}

function treeIdForRun(runId: string): string {
  return `tree-${requestHash(runId).slice(0, 24)}`;
}

function sourceWorkspaceLabel(runId: string): string {
  return `sheltie-source-${runSuffix(runId)}`;
}

function rootBranch(runId: string): string {
  return branchForNode(null, `run-${runSuffix(runId)}-root`);
}

function isUncertain(status: string): boolean {
  return status === "submitted" || status === "delivery_unknown";
}

export class RealRunController {
  constructor(
    private readonly store: SheltieStore,
    private readonly herdr: RunHerdrControl,
    private readonly options: RealRunControllerOptions,
  ) {}

  async startRun(input: StartRunInput): Promise<TreeRecord> {
    const runId = input.runId.trim();
    const taskContract = input.taskContract.trim();
    if (runId.length === 0 || runId.length > 128) throw new Error("runId must contain 1-128 characters");
    if (taskContract.length === 0) throw new Error("task contract must not be empty");
    const pong = await this.verifyRuntime();
    const repoRoot = realpathSync(input.repoRoot);
    if (!(await isCleanWorktree(repoRoot))) {
      throw new Error(`repository source ${repoRoot} must be clean before starting a run`);
    }
    const baseCommit = await resolveCommit(repoRoot, input.base);
    mkdirSync(input.worktreeRoot, { recursive: true });
    const tree = this.store.createTree({
      treeId: treeIdForRun(runId),
      runId,
      repoRoot,
      repoSourceWorkspaceId: null,
      herdrSocketPath: input.herdrSocketPath,
      herdrVersion: pong.version,
      herdrProtocol: pong.protocol,
      baseCommit,
      worktreeRoot: input.worktreeRoot,
      rootTaskContract: taskContract,
      status: "initializing",
    });
    this.options.onTreeReserved?.(tree);
    return this.resumeBootstrap();
  }

  async resumeBootstrap(): Promise<TreeRecord> {
    let tree = this.store.getOnlyTree();
    await this.verifyRuntime(tree);
    if (tree.repoSourceWorkspaceId === null) {
      tree = await this.ensureSourceWorkspace(tree);
    }
    if (this.store.findRootNode(tree.treeId) === null) {
      const branch = rootBranch(tree.runId);
      this.store.reserveNode({
        nodeId: nodeIdForRequest(tree.treeId, "root"),
        treeId: tree.treeId,
        parentNodeId: null,
        name: "root",
        depth: 0,
        branch,
        baseCommit: tree.baseCommit,
        worktreePath: worktreePathForBranch(tree.worktreeRoot, branch),
        taskContract: tree.rootTaskContract,
      });
    }
    if (tree.status === "initializing") tree = this.store.setTreeStatus(tree.treeId, "active");
    return tree;
  }

  async convergeOnce(): Promise<RealRunStatus> {
    const current = this.store.getOnlyTree();
    if (["cancel_requested", "cancelling", "cancelled", "cancel_blocked"].includes(current.status)) {
      return this.status();
    }
    let tree = await this.resumeBootstrap();
    if (tree.status === "completed" || tree.status === "failed") return this.status();
    const orchestrator = new SheltieOrchestrator(this.store, this.herdr, {
      sheltieExecutable: this.options.sheltieExecutable,
      worktreeRoot: tree.worktreeRoot,
    });
    await this.reconcileUncertainRuntimeOperations(tree, orchestrator);
    await orchestrator.processPendingNodes(tree.treeId);
    for (const node of this.store.listNodes(tree.treeId)) {
      if (node.lifecycleStatus === "completed" || node.agentName === null) continue;
      const promptOperation = this.store.findOperation(
        operationIdForRequest(tree.treeId, "prompt", `${node.nodeId}/step/initial`),
      );
      if (promptOperation === null || promptOperation.status === "reserved" || isUncertain(promptOperation.status)) {
        await orchestrator.dispatchStep(node.nodeId, "initial", node.taskContract);
      }
    }
    const nodes = this.store.listNodes(tree.treeId);
    if (nodes.some((node) => node.lifecycleStatus === "failed")) {
      tree = this.store.setTreeStatus(tree.treeId, "failed");
    } else if (nodes.some((node) => node.lifecycleStatus === "blocked")) {
      tree = this.store.setTreeStatus(tree.treeId, "blocked");
    } else if (nodes.length > 0 && nodes.every((node) => node.lifecycleStatus === "completed")) {
      tree = this.store.setTreeStatus(tree.treeId, "completed");
    } else if (tree.status !== "active") {
      tree = this.store.setTreeStatus(tree.treeId, "active");
    }
    return { ...this.status(), tree };
  }

  status(): RealRunStatus {
    const tree = this.store.getOnlyTree();
    return {
      tree,
      nodes: this.store.listNodes(tree.treeId),
      operations: this.store.listUnresolvedOperations(tree.treeId),
      steps: this.store.listSteps(tree.treeId),
      messages: this.store.listMessages(tree.treeId),
    };
  }

  private async verifyRuntime(expected?: TreeRecord): Promise<PongResult> {
    const pong = await this.herdr.ping();
    if (pong.version !== REQUIRED_HERDR_VERSION || pong.protocol !== REQUIRED_HERDR_PROTOCOL) {
      throw new Error(
        `unsupported Herdr runtime ${pong.version}/protocol-${pong.protocol}; expected ${REQUIRED_HERDR_VERSION}/protocol-${REQUIRED_HERDR_PROTOCOL}`,
      );
    }
    if (expected !== undefined && (pong.version !== expected.herdrVersion || pong.protocol !== expected.herdrProtocol)) {
      throw new Error(
        `Herdr runtime changed from ${expected.herdrVersion}/protocol-${expected.herdrProtocol} to ${pong.version}/protocol-${pong.protocol}`,
      );
    }
    return pong;
  }

  private async ensureSourceWorkspace(tree: TreeRecord): Promise<TreeRecord> {
    const request = {
      cwd: tree.repoRoot,
      focus: false,
      label: sourceWorkspaceLabel(tree.runId),
      env: { SHELTIE_RUN_ID: tree.runId },
    };
    const operationId = operationIdForRequest(tree.treeId, "workspace_create", "repo-source");
    let operation = this.store.reserveOperation({
      operationId,
      treeId: tree.treeId,
      nodeId: null,
      kind: "workspace_create",
      requestKey: "repo-source",
      requestHash: requestHash(request),
      request,
    });
    if (operation.status === "reserved") {
      operation = this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
      try {
        const created = await this.herdr.workspaceCreate(request);
        await this.options.failpoint?.("before_source_workspace_response_persist", operation.operationId);
        tree = this.store.bindRepoSourceWorkspace(tree.treeId, created.workspace.workspace_id);
        this.store.setOperationStatus(operation.operationId, "completed", { result: created });
        return tree;
      } catch (error) {
        this.store.setOperationStatus(operation.operationId, "delivery_unknown", {
          lastError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    if (operation.status === "blocked" || operation.status === "failed") {
      throw new Error(`source workspace operation is ${operation.status}: ${operation.lastError ?? "unknown error"}`);
    }
    const snapshot = await this.herdr.snapshot();
    const matches = this.matchingSourceWorkspaces(snapshot, tree, request.label);
    if (matches.length > 1) {
      this.store.setOperationStatus(operation.operationId, "blocked", {
        lastError: `found ${matches.length} source workspaces for ${request.label}`,
      });
      this.store.setTreeStatus(tree.treeId, "blocked");
      throw new Error(`source workspace ${request.label} is ambiguous`);
    }
    const workspace = matches[0];
    if (workspace === undefined) {
      throw new Error(`source workspace delivery remains unknown for ${request.label}; request was not retried`);
    }
    tree = this.store.bindRepoSourceWorkspace(tree.treeId, workspace.workspace_id);
    this.store.setOperationStatus(operation.operationId, "completed", {
      result: { reconciled: true, workspaceId: workspace.workspace_id },
    });
    return tree;
  }

  private matchingSourceWorkspaces(snapshot: SessionSnapshot, tree: TreeRecord, label: string): WorkspaceInfo[] {
    return snapshot.workspaces.filter(
      (workspace) => workspace.label === label && workspace.worktree?.checkout_path === tree.repoRoot,
    );
  }

  private async reconcileUncertainRuntimeOperations(
    tree: TreeRecord,
    orchestrator: SheltieOrchestrator,
  ): Promise<void> {
    for (const node of this.store.listNodes(tree.treeId)) {
      const worktreeOperation = this.store.findOperation(
        operationIdForRequest(tree.treeId, "worktree_create", node.nodeId),
      );
      const agentOperation = this.store.findOperation(operationIdForRequest(tree.treeId, "agent_start", node.nodeId));
      if (
        (node.workspaceId === null && worktreeOperation !== null && isUncertain(worktreeOperation.status)) ||
        (node.agentName === null && agentOperation !== null && isUncertain(agentOperation.status))
      ) {
        await orchestrator.reconcileNode(node.nodeId);
      }
    }
  }
}
