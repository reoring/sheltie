import { mkdirSync, realpathSync } from "node:fs";
import type { MessageRecord, NodeRecord, OperationRecord, StepExecutionRecord, TreeRecord } from "./db.ts";
import { SheltieStore } from "./db.ts";
import { CommandError, isCleanWorktree, resolveCommit, runGit } from "./git.ts";
import type { PongResult } from "./herdr-client.ts";
import { branchForNode, nodeIdForRequest, operationIdForRequest, requestHash } from "./ids.ts";
import {
  getManifestRole,
  parseResolvedManifest,
  type ResolvedManifestDocument,
  spawnPolicyForRole,
} from "./manifest.ts";
import { rootWorkspaceLabel, type HerdrControl, SheltieOrchestrator } from "./orchestrator.ts";
import type { RuntimeBinding } from "./runtime-bundle.ts";

const REQUIRED_HERDR_VERSION = "0.8.0";
const REQUIRED_HERDR_PROTOCOL = 20;

export type RunHerdrControl = HerdrControl;

export interface RealRunControllerOptions {
  sheltieExecutable: string;
  okfCompactionExtensionPath?: string;
  workspaceEnvironment?: Record<string, string>;
  onTreeReserved?: (tree: TreeRecord) => void | Promise<void>;
}

export interface ExpectedRuntimeIdentity {
  version: string;
  protocol: number;
}

export interface StartRunInput {
  runId: string;
  repoRoot: string;
  base: string;
  worktreeRoot: string;
  manifest: ResolvedManifestDocument;
  herdrSocketPath: string;
  runtimeBinding?: RuntimeBinding;
  expectedRuntimeIdentity?: ExpectedRuntimeIdentity;
}

/**
 * Raw controller state used only inside trusted lifecycle controllers.
 *
 * It contains task, path, runtime identity, and message details, so CLI and
 * other public serializers must project an ObservationSnapshot instead.
 */
export interface InternalRunStatus {
  tree: TreeRecord;
  nodes: NodeRecord[];
  operations: OperationRecord[];
  steps: StepExecutionRecord[];
  messages: MessageRecord[];
}

function runSuffix(runId: string): string {
  return requestHash(runId).slice(0, 12);
}

function treeIdForRun(runId: string): string {
  return `tree-${requestHash(runId).slice(0, 24)}`;
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
    if (runId.length === 0 || runId.length > 128) throw new Error("runId must contain 1-128 characters");
    const rootRole = getManifestRole(input.manifest.manifest, input.manifest.manifest.spec.root.role);
    const runtimeIdentity = await this.runtimeIdentityForReservation(input);
    const repoRoot = realpathSync(input.repoRoot);
    if (!(await isCleanWorktree(repoRoot))) {
      throw new Error(`repository source ${repoRoot} must be clean before starting a run`);
    }
    const baseCommit = await resolveCommit(repoRoot, input.base);
    mkdirSync(input.worktreeRoot, { recursive: true });
    const tree = this.store.createManifestTree(
      {
        manifestDigest: input.manifest.digest,
        apiVersion: input.manifest.manifest.apiVersion,
        resolved: input.manifest.manifest,
      },
      {
        treeId: treeIdForRun(runId),
        runId,
        repoRoot,
        repoSourceWorkspaceId: null,
        herdrSocketPath: input.herdrSocketPath,
        herdrVersion: runtimeIdentity.version,
        herdrProtocol: runtimeIdentity.protocol,
        ...(input.runtimeBinding === undefined ? {} : { runtimeBinding: input.runtimeBinding }),
        baseCommit,
        worktreeRoot: input.worktreeRoot,
        rootTaskContract: rootRole.prompt.content,
        rootSpawnPolicy: spawnPolicyForRole(input.manifest.manifest, rootRole),
        manifestDigest: input.manifest.digest,
        rootRole: rootRole.name,
        status: "initializing",
      },
    );
    await this.options.onTreeReserved?.(tree);
    return this.resumeBootstrap();
  }

  async resumeBootstrap(): Promise<TreeRecord> {
    let tree = this.store.getOnlyTree();
    if (tree.status === "cleaned") return tree;
    await this.verifyRuntime(tree);
    if (tree.manifestDigest === null || tree.rootRole === null) {
      throw new Error(`tree ${tree.treeId} has no resolved manifest identity`);
    }
    const record = this.store.getManifest(tree.manifestDigest);
    if (record === null) throw new Error(`tree ${tree.treeId} manifest ${tree.manifestDigest} is missing`);
    const manifest = parseResolvedManifest(record.resolved);
    const rootRole = getManifestRole(manifest, tree.rootRole);
    if (this.store.findRootNode(tree.treeId) === null) {
      const branch = rootBranch(tree.runId);
      await this.ensureRootBranch(tree, branch, manifest.spec.root.name);
      this.store.reserveNode({
        nodeId: nodeIdForRequest(tree.treeId, "root"),
        treeId: tree.treeId,
        parentNodeId: null,
        name: manifest.spec.root.name,
        depth: 0,
        placement: "workspace",
        spawnPolicy: spawnPolicyForRole(manifest, rootRole),
        branch,
        baseCommit: tree.baseCommit,
        worktreePath: tree.repoRoot,
        taskContract: rootRole.prompt.content,
        roleName: rootRole.name,
        roleDigest: rootRole.digest,
        parameters: {},
        resolvedCapabilities: rootRole.capabilities,
      });
    }
    if (tree.status === "initializing") tree = this.store.setTreeStatus(tree.treeId, "active");
    return tree;
  }

  async convergeOnce(): Promise<InternalRunStatus> {
    const current = this.store.getOnlyTree();
    if (["cancel_requested", "cancelling", "cancelled", "cancel_blocked", "cleaned"].includes(current.status)) {
      return this.status();
    }
    let tree = await this.resumeBootstrap();
    if (tree.status === "completed" || tree.status === "failed" || tree.status === "cleaned") return this.status();
    const orchestrator = new SheltieOrchestrator(this.store, this.herdr, {
      sheltieExecutable: this.options.sheltieExecutable,
      ...(this.options.okfCompactionExtensionPath === undefined
        ? {}
        : { okfCompactionExtensionPath: this.options.okfCompactionExtensionPath }),
      worktreeRoot: tree.worktreeRoot,
      ...(this.options.workspaceEnvironment === undefined
        ? {}
        : { workspaceEnvironment: this.options.workspaceEnvironment }),
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
    tree = this.store.getTree(tree.treeId);
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

  status(): InternalRunStatus {
    const tree = this.store.getOnlyTree();
    return {
      tree,
      nodes: this.store.listNodes(tree.treeId),
      operations: this.store.listUnresolvedOperations(tree.treeId),
      steps: this.store.listSteps(tree.treeId),
      messages: this.store.listMessages(tree.treeId),
    };
  }

  private async ensureRootBranch(tree: TreeRecord, branch: string, rootName: string): Promise<void> {
    const currentBranch = await runGit(tree.repoRoot, ["branch", "--show-current"]);
    if (currentBranch === branch) return;
    let branchHead: string | null = null;
    try {
      branchHead = await resolveCommit(tree.repoRoot, branch);
    } catch (error) {
      if (!(error instanceof CommandError && error.exitCode === 128)) throw error;
    }
    if (branchHead !== null && branchHead !== tree.baseCommit) {
      throw new Error(`root branch ${branch} points to ${branchHead}, expected base ${tree.baseCommit}`);
    }
    if (tree.status !== "initializing") {
      throw new Error(`root source checkout is on ${currentBranch || "detached HEAD"}, expected ${branch}`);
    }
    const label = rootWorkspaceLabel(rootName, nodeIdForRequest(tree.treeId, "root"));
    const rootWorkspaces = (await this.herdr.snapshot()).workspaces.filter(
      (workspace) =>
        workspace.worktree?.checkout_path === tree.repoRoot &&
        !workspace.worktree.is_linked_worktree,
    );
    const matchingWorkspaces = rootWorkspaces.filter(
      (workspace) =>
        workspace.label === label &&
        (tree.repoSourceWorkspaceId === null || workspace.workspace_id === tree.repoSourceWorkspaceId),
    );
    if (rootWorkspaces.length !== matchingWorkspaces.length || matchingWorkspaces.length > 1) {
      throw new Error(
        `root source checkout ${tree.repoRoot} is open in a foreign or ambiguous Herdr workspace`,
      );
    }
    if (branchHead === null) await runGit(tree.repoRoot, ["switch", "-c", branch, tree.baseCommit]);
    else await runGit(tree.repoRoot, ["switch", branch]);
  }

  private async runtimeIdentityForReservation(input: StartRunInput): Promise<ExpectedRuntimeIdentity> {
    const binding = input.runtimeBinding;
    if (binding?.mode !== "bundled") {
      if (input.expectedRuntimeIdentity !== undefined) {
        throw new Error("expected runtime identity is valid only with a bundled runtime binding");
      }
      const pong = await this.verifyRuntime();
      return { version: pong.version, protocol: pong.protocol };
    }
    const expected = input.expectedRuntimeIdentity;
    if (expected === undefined) {
      throw new Error("bundled run start requires a trusted expected runtime identity");
    }
    if (expected.version !== binding.herdr.version || expected.protocol !== binding.herdr.protocol) {
      throw new Error("expected runtime identity does not match the bundled runtime binding");
    }
    return { version: binding.herdr.version, protocol: binding.herdr.protocol };
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


  private async reconcileUncertainRuntimeOperations(
    tree: TreeRecord,
    orchestrator: SheltieOrchestrator,
  ): Promise<void> {
    for (const node of this.store.listNodes(tree.treeId)) {
      const runtimeOperation = this.store.findOperation(
        operationIdForRequest(
          tree.treeId,
          node.placement === "tab"
            ? "tab_create"
            : node.parentNodeId === null
              ? "workspace_create"
              : "worktree_create",
          node.nodeId,
        ),
      );
      const agentOperation = this.store.findOperation(operationIdForRequest(tree.treeId, "agent_start", node.nodeId));
      if (
        (node.workspaceId === null && runtimeOperation !== null && isUncertain(runtimeOperation.status)) ||
        (node.agentName === null && agentOperation !== null && isUncertain(agentOperation.status))
      ) {
        await orchestrator.reconcileNode(node.nodeId);
      }
    }
  }
}
