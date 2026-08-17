import { existsSync } from "node:fs";
import type {
  CleanupPlanRecord,
  CleanupReceiptRecord,
  NodeRecord,
  OperationRecord,
  TreeRecord,
} from "./db.ts";
import { SheltieStore } from "./db.ts";
import {
  CommandError,
  commitExistsOnBranch,
  hasMergeInProgress,
  isCleanWorktree,
  resolveCommit,
  runGit,
} from "./git.ts";
import type {
  PongResult,
  SessionSnapshot,
  WorktreeInfo,
} from "./herdr-client.ts";
import { isRecord } from "./type-guards.ts";
import { requestHash } from "./ids.ts";

export interface CleanupHerdrControl {
  ping(): Promise<PongResult>;
  snapshot(): Promise<SessionSnapshot>;
  worktreeList(params: { workspace_id?: string; cwd?: string }): Promise<{
    type: "worktree_list";
    source: { repo_root: string; source_workspace_id?: string };
    worktrees: WorktreeInfo[];
  }>;
  worktreeRemove(params: { workspace_id: string; force: boolean }): Promise<{
    type: "worktree_removed";
    workspace_id: string;
    path: string;
    forced: boolean;
  }>;
  workspaceClose(params: { workspace_id: string }): Promise<{ type: "ok" }>;
}

export interface RemoveWorktreeAction {
  kind: "remove_worktree";
  nodeId: string;
  workspaceId: string;
  worktreePath: string;
  branch: string;
  headCommitSha: string;
  paneIds: string[];
  tabIds: string[];
  terminalIds: string[];
}

export interface DeleteChildBranchAction {
  kind: "delete_child_branch";
  nodeId: string;
  branch: string;
  headCommitSha: string;
  parentBranch: string;
  parentHeadCommitSha: string;
  parentWorktreePath: string;
  mergeReceiptId: string;
}

export interface CloseSourceWorkspaceAction {
  kind: "close_source_workspace";
  workspaceId: string;
  repoRoot: string;
  paneIds: string[];
  tabIds: string[];
}

export type CleanupAction =
  | RemoveWorktreeAction
  | DeleteChildBranchAction
  | CloseSourceWorkspaceAction;

export interface CleanupPlanContent {
  schemaVersion: 2;
  runId: string;
  treeId: string;
  treeGeneration: number;
  manifestDigest: string | null;
  repoRoot: string;
  herdrSocketPath: string;
  herdrSession: string;
  herdrVersion: string;
  herdrProtocol: number;
  workspaceIds: string[];
  paneIds: string[];
  tabIds: string[];
  terminalIds: string[];
  worktreePaths: string[];
  branchNames: string[];
  headCommitShas: string[];
  mergeReceiptIds: string[];
  actions: CleanupAction[];
  blockers: string[];
}

export interface CleanupPlan extends CleanupPlanContent {
  planDigest: string;
}

export type CleanupFailpoint = "after_action_before_receipt";

export interface CleanupControllerOptions {
  failpoint?: (name: CleanupFailpoint, action: CleanupAction) => void | Promise<void>;
}

export interface CleanupApplyResult {
  plan: CleanupPlan;
  tree: TreeRecord;
  receipts: CleanupReceiptRecord[];
  duplicate: boolean;
}

interface RuntimeInventory {
  snapshot: SessionSnapshot;
  listed: Awaited<ReturnType<CleanupHerdrControl["worktreeList"]>>;
}

const TERMINAL_TREE_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "cancel_blocked"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = left.toSorted();
  const sortedRight = right.toSorted();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function containsOnlyOwned(actual: readonly string[], owned: readonly string[]): boolean {
  const ownedSet = new Set(owned);
  return actual.every((value) => ownedSet.has(value));
}


function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`cleanup plan ${key} must be a string`);
  return value;
}

function requiredNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`cleanup plan ${key} must be a string or null`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`cleanup plan ${key} must be an integer`);
  }
  return value;
}

function requiredStrings(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`cleanup plan ${key} must be a string array`);
  }
  return [...value];
}

function parseAction(value: unknown): CleanupAction {
  if (!isRecord(value)) throw new Error("cleanup plan action must be an object");
  const kind = requiredString(value, "kind");
  if (kind === "remove_worktree") {
    return {
      kind,
      nodeId: requiredString(value, "nodeId"),
      workspaceId: requiredString(value, "workspaceId"),
      worktreePath: requiredString(value, "worktreePath"),
      branch: requiredString(value, "branch"),
      headCommitSha: requiredString(value, "headCommitSha"),
      paneIds: requiredStrings(value, "paneIds"),
      tabIds: requiredStrings(value, "tabIds"),
      terminalIds: requiredStrings(value, "terminalIds"),
    };
  }
  if (kind === "delete_child_branch") {
    return {
      kind,
      nodeId: requiredString(value, "nodeId"),
      branch: requiredString(value, "branch"),
      headCommitSha: requiredString(value, "headCommitSha"),
      parentBranch: requiredString(value, "parentBranch"),
      parentHeadCommitSha: requiredString(value, "parentHeadCommitSha"),
      parentWorktreePath: requiredString(value, "parentWorktreePath"),
      mergeReceiptId: requiredString(value, "mergeReceiptId"),
    };
  }
  if (kind === "close_source_workspace") {
    return {
      kind,
      workspaceId: requiredString(value, "workspaceId"),
      repoRoot: requiredString(value, "repoRoot"),
      paneIds: requiredStrings(value, "paneIds"),
      tabIds: requiredStrings(value, "tabIds"),
    };
  }
  throw new Error(`unknown cleanup action ${kind}`);
}

function parseCleanupPlan(value: unknown): CleanupPlan {
  if (!isRecord(value)) throw new Error("persisted cleanup plan must be an object");
  if (requiredNumber(value, "schemaVersion") !== 2) throw new Error("unsupported cleanup plan schema");
  const actionValues = value.actions;
  if (!Array.isArray(actionValues)) throw new Error("cleanup plan actions must be an array");
  return {
    schemaVersion: 2,
    runId: requiredString(value, "runId"),
    treeId: requiredString(value, "treeId"),
    treeGeneration: requiredNumber(value, "treeGeneration"),
    manifestDigest: requiredNullableString(value, "manifestDigest"),
    repoRoot: requiredString(value, "repoRoot"),
    herdrSocketPath: requiredString(value, "herdrSocketPath"),
    herdrSession: requiredString(value, "herdrSession"),
    herdrVersion: requiredString(value, "herdrVersion"),
    herdrProtocol: requiredNumber(value, "herdrProtocol"),
    workspaceIds: requiredStrings(value, "workspaceIds"),
    paneIds: requiredStrings(value, "paneIds"),
    tabIds: requiredStrings(value, "tabIds"),
    terminalIds: requiredStrings(value, "terminalIds"),
    worktreePaths: requiredStrings(value, "worktreePaths"),
    branchNames: requiredStrings(value, "branchNames"),
    headCommitShas: requiredStrings(value, "headCommitShas"),
    mergeReceiptIds: requiredStrings(value, "mergeReceiptIds"),
    actions: actionValues.map(parseAction),
    blockers: requiredStrings(value, "blockers"),
    planDigest: requiredString(value, "planDigest"),
  };
}

function planWithDigest(content: CleanupPlanContent): CleanupPlan {
  return { ...content, planDigest: requestHash(content) };
}

function mergeReceiptCommit(operation: OperationRecord): string | null {
  if (!isRecord(operation.result)) return null;
  const childCommitSha = operation.result.childCommitSha;
  return typeof childCommitSha === "string" ? childCommitSha : null;
}

async function optionalCommit(repoRoot: string, branch: string): Promise<string | null> {
  try {
    return await resolveCommit(repoRoot, branch);
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 128) return null;
    throw error;
  }
}

function targetForAction(action: CleanupAction): string {
  if (action.kind === "remove_worktree") return action.worktreePath;
  if (action.kind === "delete_child_branch") return action.branch;
  return action.workspaceId;
}

export class CleanupController {
  constructor(
    private readonly store: SheltieStore,
    private readonly herdr: CleanupHerdrControl,
    private readonly options: CleanupControllerOptions = {},
  ) {}

  async preview(): Promise<CleanupPlan> {
    const tree = this.store.getOnlyTree();
    if (tree.status === "cleaned") {
      const completed = this.store.getLatestCompletedCleanupPlan(tree.treeId);
      if (completed === null) throw new Error(`cleaned tree ${tree.treeId} has no cleanup receipt`);
      return this.planFromRecord(completed);
    }
    return this.buildPlan();
  }

  async apply(planDigest?: string): Promise<CleanupApplyResult> {
    if (planDigest === undefined || planDigest.length === 0) throw new Error("--plan-digest is required with --apply");
    if (!SHA256_PATTERN.test(planDigest)) throw new Error("plan digest mismatch");

    const persisted = this.store.getCleanupPlan(planDigest);
    if (persisted?.status === "completed") {
      const plan = this.planFromRecord(persisted);
      return {
        plan,
        tree: this.store.getTree(plan.treeId),
        receipts: this.store.listCleanupReceipts(planDigest),
        duplicate: true,
      };
    }

    let plan: CleanupPlan;
    if (persisted === null) {
      plan = await this.buildPlan();
      if (plan.planDigest !== planDigest) throw new Error("plan digest mismatch; run cleanup preview again");
      this.rejectBlockedPlan(plan);
      this.store.createCleanupPlan({
        planDigest,
        treeId: plan.treeId,
        treeGeneration: plan.treeGeneration,
        manifestDigest: plan.manifestDigest,
        plan,
      });
      const immediateReadback = await this.buildPlan();
      if (immediateReadback.planDigest !== planDigest) {
        throw new Error("cleanup plan changed during apply preflight");
      }
      this.rejectBlockedPlan(immediateReadback);
    } else {
      plan = this.planFromRecord(persisted);
    }

    await this.validatePersistedPlan(plan);
    const completedIndexes = new Set(
      this.store.listCleanupReceipts(plan.planDigest).map((receipt) => receipt.actionIndex),
    );
    for (const [actionIndex, action] of plan.actions.entries()) {
      if (completedIndexes.has(actionIndex)) continue;
      const outcome = await this.applyAction(plan, action);
      await this.options.failpoint?.("after_action_before_receipt", action);
      this.store.recordCleanupReceipt({
        planDigest: plan.planDigest,
        actionIndex,
        actionKind: action.kind,
        target: targetForAction(action),
        outcome,
        details: { action },
      });
    }
    await this.validateRunSafety(plan);
    const tree = this.store.completeCleanupPlan(plan.planDigest);
    return {
      plan,
      tree,
      receipts: this.store.listCleanupReceipts(plan.planDigest),
      duplicate: false,
    };
  }

  private async buildPlan(): Promise<CleanupPlan> {
    const tree = this.store.getOnlyTree();
    const [pong, inventory] = await Promise.all([this.herdr.ping(), this.readInventory(tree)]);
    const blockers: string[] = [];
    if (!TERMINAL_TREE_STATUSES.has(tree.status)) {
      blockers.push(`tree status ${tree.status} is not terminal`);
    }
    if (pong.version !== tree.herdrVersion || pong.protocol !== tree.herdrProtocol) {
      blockers.push(
        `Herdr runtime changed from ${tree.herdrVersion}/protocol-${tree.herdrProtocol} to ${pong.version}/protocol-${pong.protocol}`,
      );
    }
    const unresolved = this.store.listUnresolvedOperations(tree.treeId);
    for (const operation of unresolved) {
      blockers.push(`unresolved operation ${operation.operationId} is ${operation.status}`);
    }

    const nodes = this.store
      .listNodes(tree.treeId)
      .toSorted((left, right) => right.depth - left.depth || left.nodeId.localeCompare(right.nodeId));
    const workspaceNodes = nodes.filter((node) => node.placement === "workspace");
    const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
    const mergeOperations = this.store
      .listOperations(tree.treeId)
      .filter((operation) => operation.kind === "merge" && operation.status === "completed");
    const actions: CleanupAction[] = [];
    const branchNames: string[] = [];
    const headCommitShas: string[] = [];
    const mergeReceiptIds: string[] = [];

    this.validateSourceIdentity(tree, inventory, blockers);
    const ownedWorkspaceIds = new Set<string>();
    if (tree.repoSourceWorkspaceId !== null) ownedWorkspaceIds.add(tree.repoSourceWorkspaceId);

    for (const node of nodes) {
      if (node.workspaceId === null || node.tabId === null || node.paneId === null) {
        blockers.push(`node ${node.nodeId} has incomplete DB runtime identity`);
        continue;
      }
      ownedWorkspaceIds.add(node.workspaceId);
      if (node.placement !== "tab") continue;
      const parent = node.parentNodeId === null ? undefined : nodesById.get(node.parentNodeId);
      if (
        parent === undefined ||
        parent.workspaceId !== node.workspaceId ||
        parent.branch !== node.branch ||
        parent.worktreePath !== node.worktreePath
      ) {
        blockers.push(`tab node ${node.nodeId} does not share its parent workspace, branch, and worktree`);
      }
    }

    for (const node of workspaceNodes) {
      branchNames.push(node.branch);
      if (node.workspaceId === null || node.tabId === null || node.paneId === null) continue;
      const workspaceId = node.workspaceId;
      const headCommitSha = await this.readNodeHead(node.nodeId, node.worktreePath, blockers);
      if (headCommitSha === null) continue;
      headCommitShas.push(headCommitSha);
      if (
        node.parentNodeId === null &&
        node.worktreePath === tree.repoRoot &&
        node.workspaceId === tree.repoSourceWorkspaceId
      ) {
        await this.validateCheckout(node, headCommitSha, blockers);
        continue;
      }
      await this.validateWorktree(
        {
          nodeId: node.nodeId,
          workspaceId,
          branch: node.branch,
          worktreePath: node.worktreePath,
        },
        headCommitSha,
        inventory,
        blockers,
      );
      const workspaceNodesInDb = nodes.filter((candidate) => candidate.workspaceId === workspaceId);
      const expectedPaneIds = workspaceNodesInDb.flatMap((candidate) =>
        candidate.paneId === null ? [] : [candidate.paneId],
      );
      const expectedTabIds = workspaceNodesInDb.flatMap((candidate) =>
        candidate.tabId === null ? [] : [candidate.tabId],
      );
      const workspacePanes = inventory.snapshot.panes.filter(
        (candidate) => candidate.workspace_id === workspaceId,
      );
      const workspaceTabs = inventory.snapshot.tabs.filter(
        (candidate) => candidate.workspace_id === workspaceId,
      );
      const actualPaneIds = workspacePanes.map((candidate) => candidate.pane_id);
      const actualTabIds = workspaceTabs.map((candidate) => candidate.tab_id);
      if (!containsOnlyOwned(actualPaneIds, expectedPaneIds)) {
        blockers.push(`Herdr workspace ${workspaceId} contains a pane not owned by this run`);
      }
      if (!containsOnlyOwned(expectedPaneIds, actualPaneIds)) {
        blockers.push(`Herdr workspace ${workspaceId} is missing a pane owned by this run`);
      }
      if (!containsOnlyOwned(actualTabIds, expectedTabIds)) {
        blockers.push(`Herdr workspace ${workspaceId} contains a tab not owned by this run`);
      }
      if (!containsOnlyOwned(expectedTabIds, actualTabIds)) {
        blockers.push(`Herdr workspace ${workspaceId} is missing a tab owned by this run`);
      }
      actions.push({
        kind: "remove_worktree",
        nodeId: node.nodeId,
        workspaceId,
        worktreePath: node.worktreePath,
        branch: node.branch,
        headCommitSha,
        paneIds: workspacePanes.map((candidate) => candidate.pane_id),
        tabIds: workspaceTabs.map((candidate) => candidate.tab_id),
        terminalIds: workspaceNodesInDb.flatMap((candidate) =>
          candidate.terminalId === null ? [] : [candidate.terminalId],
        ),
      });

      if (node.parentNodeId === null) continue;
      const parent = nodesById.get(node.parentNodeId);
      if (parent === undefined) {
        blockers.push(`node ${node.nodeId} parent ${node.parentNodeId} is absent from DB`);
        continue;
      }
      const parentHead = await optionalCommit(tree.repoRoot, parent.branch);
      if (parentHead === null) {
        blockers.push(`parent branch ${parent.branch} is missing`);
        continue;
      }
      if (!(await commitExistsOnBranch(tree.repoRoot, headCommitSha, parent.branch))) {
        blockers.push(`child commit ${headCommitSha} is not merged into parent branch ${parent.branch}`);
        continue;
      }
      const receipts = mergeOperations.filter(
        (operation) => operation.requestKey === node.nodeId && mergeReceiptCommit(operation) === headCommitSha,
      );
      if (receipts.length !== 1) {
        blockers.push(`child branch ${node.branch} has ${receipts.length} exact merge receipts`);
        continue;
      }
      const receipt = receipts[0];
      if (receipt === undefined) continue;
      mergeReceiptIds.push(receipt.operationId);
      actions.push({
        kind: "delete_child_branch",
        nodeId: node.nodeId,
        branch: node.branch,
        headCommitSha,
        parentBranch: parent.branch,
        parentWorktreePath: parent.worktreePath,
        parentHeadCommitSha: parentHead,
        mergeReceiptId: receipt.operationId,
      });
    }

    for (const agent of inventory.snapshot.agents) {
      if (ownedWorkspaceIds.has(agent.workspace_id)) {
        blockers.push(`active agent ${agent.name ?? agent.pane_id} exists in workspace ${agent.workspace_id}`);
      }
    }

    const sourceAction = this.sourceAction(tree, nodes, inventory, blockers);
    if (sourceAction !== null) actions.push(sourceAction);
    const workspaceIds = unique(
      actions.flatMap((action) => {
        if (action.kind === "delete_child_branch") return [];
        return [action.workspaceId];
      }),
    );
    const paneIds = unique(actions.flatMap((action) => (action.kind === "delete_child_branch" ? [] : action.paneIds)));
    const tabIds = unique(actions.flatMap((action) => (action.kind === "delete_child_branch" ? [] : action.tabIds)));
    const terminalIds = unique(nodes.flatMap((node) => (node.terminalId === null ? [] : [node.terminalId])));
    const worktreePaths = actions.flatMap((action) =>
      action.kind === "remove_worktree" ? [action.worktreePath] : [],
    );

    return planWithDigest({
      schemaVersion: 2,
      runId: tree.runId,
      treeId: tree.treeId,
      treeGeneration: tree.generation,
      manifestDigest: tree.manifestDigest,
      repoRoot: tree.repoRoot,
      herdrSocketPath: tree.herdrSocketPath,
      herdrSession: tree.herdrSocketPath,
      herdrVersion: tree.herdrVersion,
      herdrProtocol: tree.herdrProtocol,
      workspaceIds,
      paneIds,
      tabIds,
      terminalIds,
      worktreePaths,
      branchNames,
      headCommitShas,
      mergeReceiptIds,
      actions,
      blockers: unique(blockers),
    });
  }

  private async readInventory(tree: TreeRecord): Promise<RuntimeInventory> {
    const snapshot = await this.herdr.snapshot();
    const sourceWorkspaceIsOpen =
      tree.repoSourceWorkspaceId !== null &&
      snapshot.workspaces.some((workspace) => workspace.workspace_id === tree.repoSourceWorkspaceId);
    const listed = await this.herdr.worktreeList(
      sourceWorkspaceIsOpen && tree.repoSourceWorkspaceId !== null
        ? { workspace_id: tree.repoSourceWorkspaceId }
        : { cwd: tree.repoRoot },
    );
    return { snapshot, listed };
  }

  private validateSourceIdentity(
    tree: TreeRecord,
    inventory: RuntimeInventory,
    blockers: string[],
  ): void {
    if (tree.repoSourceWorkspaceId === null) {
      if (
        inventory.listed.source.repo_root !== tree.repoRoot ||
        inventory.listed.source.source_workspace_id !== undefined
      ) {
        blockers.push("repository cwd source identity does not match Herdr worktree inventory");
      }
      return;
    }
    if (
      inventory.listed.source.repo_root !== tree.repoRoot ||
      inventory.listed.source.source_workspace_id !== tree.repoSourceWorkspaceId
    ) {
      blockers.push("DB repository source identity does not match Herdr worktree source");
    }
    const matches = inventory.snapshot.workspaces.filter(
      (candidate) => candidate.workspace_id === tree.repoSourceWorkspaceId,
    );
    if (matches.length !== 1) {
      blockers.push("DB repository source workspace does not match Herdr snapshot");
      return;
    }
    const worktree = matches[0]?.worktree;
    if (
      worktree !== undefined &&
      (worktree.repo_root !== tree.repoRoot ||
        worktree.checkout_path !== tree.repoRoot ||
        worktree.is_linked_worktree)
    ) {
      blockers.push("DB repository source workspace does not match Herdr snapshot");
    }
  }

  private sourceAction(
    tree: TreeRecord,
    nodes: readonly NodeRecord[],
    inventory: RuntimeInventory,
    blockers: string[],
  ): CloseSourceWorkspaceAction | null {
    if (tree.repoSourceWorkspaceId === null) return null;
    const source = inventory.snapshot.workspaces.find(
      (candidate) => candidate.workspace_id === tree.repoSourceWorkspaceId,
    );
    if (source === undefined) return null;
    const paneIds = inventory.snapshot.panes
      .filter((candidate) => candidate.workspace_id === source.workspace_id)
      .map((candidate) => candidate.pane_id);
    const tabIds = inventory.snapshot.tabs
      .filter((candidate) => candidate.workspace_id === source.workspace_id)
      .map((candidate) => candidate.tab_id);
    const sourceNodes = nodes.filter((node) => node.workspaceId === source.workspace_id);
    if (sourceNodes.length === 0) {
      if (paneIds.length === 0 || tabIds.length === 0) {
        blockers.push(`source workspace ${source.workspace_id} has incomplete Herdr pane identity`);
      }
    } else {
      const expectedPaneIds = sourceNodes.flatMap((node) => (node.paneId === null ? [] : [node.paneId]));
      const expectedTabIds = sourceNodes.flatMap((node) => (node.tabId === null ? [] : [node.tabId]));
      if (!containsOnlyOwned(paneIds, expectedPaneIds)) {
        blockers.push(`root workspace ${source.workspace_id} contains a pane not owned by this run`);
      }
      if (!containsOnlyOwned(expectedPaneIds, paneIds)) {
        blockers.push(`root workspace ${source.workspace_id} is missing a pane owned by this run`);
      }
      if (!containsOnlyOwned(tabIds, expectedTabIds)) {
        blockers.push(`root workspace ${source.workspace_id} contains a tab not owned by this run`);
      }
      if (!containsOnlyOwned(expectedTabIds, tabIds)) {
        blockers.push(`root workspace ${source.workspace_id} is missing a tab owned by this run`);
      }
    }
    return {
      kind: "close_source_workspace",
      workspaceId: source.workspace_id,
      repoRoot: tree.repoRoot,
      paneIds,
      tabIds,
    };
  }

  private async readNodeHead(
    nodeId: string,
    worktreePath: string,
    blockers: string[],
  ): Promise<string | null> {
    if (!existsSync(worktreePath)) {
      blockers.push(`node ${nodeId} worktree path ${worktreePath} is missing`);
      return null;
    }
    try {
      return await resolveCommit(worktreePath, "HEAD");
    } catch (error) {
      blockers.push(`node ${nodeId} HEAD cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async validateCheckout(
    node: {
      nodeId: string;
      branch: string;
      worktreePath: string;
    },
    headCommitSha: string,
    blockers: string[],
  ): Promise<void> {
    if (!(await isCleanWorktree(node.worktreePath))) {
      blockers.push(`dirty worktree ${node.worktreePath} is preserved`);
    }
    if (await hasMergeInProgress(node.worktreePath)) {
      blockers.push(`worktree ${node.worktreePath} has MERGE_HEAD and is preserved`);
    }
    const branchHead = await optionalCommit(node.worktreePath, node.branch);
    if (branchHead !== headCommitSha) {
      blockers.push(`Git branch ${node.branch} does not match worktree HEAD ${headCommitSha}`);
    }
  }

  private async validateWorktree(
    node: {
      nodeId: string;
      workspaceId: string;
      branch: string;
      worktreePath: string;
    },
    headCommitSha: string,
    inventory: RuntimeInventory,
    blockers: string[],
  ): Promise<void> {
    await this.validateCheckout(node, headCommitSha, blockers);
    const listedMatches = inventory.listed.worktrees.filter(
      (candidate) => candidate.path === node.worktreePath,
    );
    const listed = listedMatches[0];
    if (
      listedMatches.length !== 1 ||
      listed?.branch !== node.branch ||
      listed.open_workspace_id !== node.workspaceId ||
      !listed.is_linked_worktree ||
      listed.is_prunable
    ) {
      blockers.push(`node ${node.nodeId} Herdr worktree identity does not match DB and Git`);
    }
    const workspaces = inventory.snapshot.workspaces.filter(
      (candidate) => candidate.workspace_id === node.workspaceId,
    );
    const workspace = workspaces[0];
    if (
      workspaces.length !== 1 ||
      workspace?.worktree?.checkout_path !== node.worktreePath ||
      workspace.worktree.repo_root !== inventory.listed.source.repo_root ||
      !workspace.worktree.is_linked_worktree
    ) {
      blockers.push(`node ${node.nodeId} Herdr workspace identity does not match DB and Git`);
    }
  }

  private async validatePersistedPlan(plan: CleanupPlan): Promise<void> {
    if (requestHash(this.contentOf(plan)) !== plan.planDigest) {
      throw new Error(`persisted cleanup plan ${plan.planDigest} failed digest verification`);
    }
    await this.validateRunSafety(plan);
    const tree = this.store.getTree(plan.treeId);
    const inventory = await this.readInventory(tree);
    for (const action of plan.actions) await this.validateActionState(plan, action, inventory);
  }

  private async validateRunSafety(plan: CleanupPlan): Promise<void> {
    const tree = this.store.getTree(plan.treeId);
    if (
      tree.runId !== plan.runId ||
      tree.repoRoot !== plan.repoRoot ||
      tree.herdrSocketPath !== plan.herdrSocketPath ||
      tree.manifestDigest !== plan.manifestDigest
    ) {
      throw new Error(`tree ${plan.treeId} identity changed after preview`);
    }
    if (tree.generation !== plan.treeGeneration) {
      throw new Error(`tree generation changed from ${plan.treeGeneration} to ${tree.generation}`);
    }
    if (!TERMINAL_TREE_STATUSES.has(tree.status)) throw new Error(`tree status ${tree.status} is not terminal`);
    const unresolved = this.store.listUnresolvedOperations(tree.treeId);
    if (unresolved.length > 0) throw new Error(`cleanup has ${unresolved.length} unresolved operation records`);
    const [pong, snapshot] = await Promise.all([this.herdr.ping(), this.herdr.snapshot()]);
    if (pong.version !== plan.herdrVersion || pong.protocol !== plan.herdrProtocol) {
      throw new Error("Herdr runtime identity changed after preview");
    }
    if (snapshot.agents.some((agent) => plan.workspaceIds.includes(agent.workspace_id))) {
      throw new Error("cleanup run has an active agent");
    }
  }

  private async validateActionState(
    plan: CleanupPlan,
    action: CleanupAction,
    inventory?: RuntimeInventory,
  ): Promise<"present" | "absent"> {
    if (action.kind === "delete_child_branch") {
      const head = await optionalCommit(plan.repoRoot, action.branch);
      if (head === null) return "absent";
      if (head !== action.headCommitSha) {
        throw new Error(`branch ${action.branch} changed from ${action.headCommitSha} to ${head}`);
      }
      const parentHead = await optionalCommit(plan.repoRoot, action.parentBranch);
      if (parentHead !== action.parentHeadCommitSha) {
        throw new Error(`parent branch ${action.parentBranch} changed after preview`);
      }
      if (!(await commitExistsOnBranch(plan.repoRoot, action.headCommitSha, action.parentBranch))) {
        throw new Error(`child branch ${action.branch} is no longer merged into ${action.parentBranch}`);
      }
      return "present";
    }

    const current = inventory ?? (await this.readInventory(this.store.getTree(plan.treeId)));
    if (action.kind === "close_source_workspace") {
      const matches = current.snapshot.workspaces.filter(
        (candidate) => candidate.workspace_id === action.workspaceId,
      );
      if (matches.length === 0) return "absent";
      const source = matches[0];
      const paneIds = current.snapshot.panes
        .filter((candidate) => candidate.workspace_id === action.workspaceId)
        .map((candidate) => candidate.pane_id);
      const tabIds = current.snapshot.tabs
        .filter((candidate) => candidate.workspace_id === action.workspaceId)
        .map((candidate) => candidate.tab_id);
      if (!sameValues(paneIds, action.paneIds) || !sameValues(tabIds, action.tabIds)) {
        throw new Error(`source workspace ${action.workspaceId} pane identity changed after preview`);
      }
      const worktree = source?.worktree;
      if (
        matches.length !== 1 ||
        current.listed.source.repo_root !== action.repoRoot ||
        current.listed.source.source_workspace_id !== action.workspaceId ||
        (worktree !== undefined &&
          (worktree.repo_root !== action.repoRoot ||
            worktree.checkout_path !== action.repoRoot ||
            worktree.is_linked_worktree))
      ) {
        throw new Error(`source workspace ${action.workspaceId} identity changed after preview`);
      }
      return "present";
    }

    const workspaceMatches = current.snapshot.workspaces.filter(
      (candidate) => candidate.workspace_id === action.workspaceId,
    );
    const worktreeMatches = current.listed.worktrees.filter(
      (candidate) => candidate.path === action.worktreePath,
    );
    const pathExists = existsSync(action.worktreePath);
    if (workspaceMatches.length === 0 && worktreeMatches.length === 0 && !pathExists) return "absent";
    const workspace = workspaceMatches[0];
    const worktree = worktreeMatches[0];
    const paneIds = current.snapshot.panes
      .filter((candidate) => candidate.workspace_id === action.workspaceId)
      .map((candidate) => candidate.pane_id);
    const tabIds = current.snapshot.tabs
      .filter((candidate) => candidate.workspace_id === action.workspaceId)
      .map((candidate) => candidate.tab_id);
    if (!sameValues(paneIds, action.paneIds) || !sameValues(tabIds, action.tabIds)) {
      throw new Error(`worktree ${action.worktreePath} pane identity changed after preview`);
    }
    if (
      workspaceMatches.length !== 1 ||
      worktreeMatches.length !== 1 ||
      !pathExists ||
      workspace?.worktree?.checkout_path !== action.worktreePath ||
      !workspace.worktree.is_linked_worktree ||
      worktree?.branch !== action.branch ||
      worktree.open_workspace_id !== action.workspaceId ||
      !worktree.is_linked_worktree
    ) {
      throw new Error(`worktree ${action.worktreePath} identity changed after preview`);
    }
    const head = await resolveCommit(action.worktreePath, "HEAD");
    if (head !== action.headCommitSha) {
      throw new Error(`worktree ${action.worktreePath} HEAD changed from ${action.headCommitSha} to ${head}`);
    }
    if (!(await isCleanWorktree(action.worktreePath))) {
      throw new Error(`dirty worktree ${action.worktreePath} is preserved`);
    }
    if (await hasMergeInProgress(action.worktreePath)) {
      throw new Error(`worktree ${action.worktreePath} has MERGE_HEAD and is preserved`);
    }
    return "present";
  }

  private async applyAction(
    plan: CleanupPlan,
    action: CleanupAction,
  ): Promise<CleanupReceiptRecord["outcome"]> {
    await this.validateRunSafety(plan);
    if ((await this.validateActionState(plan, action)) === "absent") return "already_absent";
    try {
      if (action.kind === "remove_worktree") {
        await this.herdr.worktreeRemove({ workspace_id: action.workspaceId, force: false });
      } else if (action.kind === "delete_child_branch") {
        await runGit(action.parentWorktreePath, ["branch", "-d", "--", action.branch]);
      } else {
        await this.herdr.workspaceClose({ workspace_id: action.workspaceId });
      }
    } catch (error) {
      if ((await this.validateActionState(plan, action)) !== "absent") throw error;
      return "removed";
    }
    if ((await this.validateActionState(plan, action)) !== "absent") {
      throw new Error(`${action.kind} did not remove ${targetForAction(action)}`);
    }
    return "removed";
  }

  private rejectBlockedPlan(plan: CleanupPlan): void {
    if (plan.blockers.length > 0) {
      throw new Error(`cleanup is blocked:\n${plan.blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
    }
  }

  private planFromRecord(record: CleanupPlanRecord): CleanupPlan {
    const plan = parseCleanupPlan(record.plan);
    const tree = this.store.getTree(plan.treeId);
    if (
      plan.planDigest !== record.planDigest ||
      plan.treeId !== record.treeId ||
      plan.treeGeneration !== record.treeGeneration ||
      plan.manifestDigest !== record.manifestDigest ||
      tree.manifestDigest !== plan.manifestDigest
    ) {
      throw new Error(`cleanup plan ${record.planDigest} record does not match its payload and tree`);
    }
    return plan;
  }

  private contentOf(plan: CleanupPlan): CleanupPlanContent {
    const { planDigest: _planDigest, ...content } = plan;
    return content;
  }
}
