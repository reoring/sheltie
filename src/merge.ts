import type { OperationRecord } from "./db.ts";
import { SheltieStore } from "./db.ts";
import {
  CommandError,
  commitExistsOnBranch,
  hasMergeInProgress,
  isCleanWorktree,
  resolveCommit,
  runGit,
} from "./git.ts";
import { operationIdForRequest, requestHash } from "./ids.ts";
import { getManifestRole, parseResolvedManifest } from "./manifest.ts";

export class MergeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeBlockedError";
  }
}

export type MergeFailpoint = "after_git_merge";

export interface MergeControllerOptions {
  failpoint?: (name: MergeFailpoint, operationId: string) => void | Promise<void>;
}

export interface MergeResult {
  operation: OperationRecord;
  parentNodeId: string;
  childNodeId: string;
  childCommitSha: string;
  mergeCommitSha: string;
  duplicate: boolean;
  reconciled: boolean;
}

interface MergeReceipt {
  operationId: string;
  childNodeId: string;
  childCommitSha: string;
}

function receiptLines(receipt: MergeReceipt): string[] {
  return [
    `Sheltie-Operation: ${receipt.operationId}`,
    `Sheltie-Child-Node: ${receipt.childNodeId}`,
    `Sheltie-Child-Commit: ${receipt.childCommitSha}`,
  ];
}

function hasExactReceipt(message: string, receipt: MergeReceipt): boolean {
  const lines = new Set(message.split("\n").map((line) => line.trim()));
  return receiptLines(receipt).every((line) => lines.has(line));
}

function operationResultCommit(operation: OperationRecord): string | null {
  if (operation.result === null || typeof operation.result !== "object") return null;
  const mergeCommitSha = (operation.result as Record<string, unknown>).mergeCommitSha;
  return typeof mergeCommitSha === "string" ? mergeCommitSha : null;
}

export class MergeController {
  constructor(
    private readonly store: SheltieStore,
    private readonly options: MergeControllerOptions = {},
  ) {}

  async mergeChild(input: { parentPaneId: string; childNodeId: string }): Promise<MergeResult> {
    const parent = this.store.findNodeByPane(input.parentPaneId);
    if (parent === null) throw new Error(`no sheltie node is bound to pane ${input.parentPaneId}`);
    const tree = this.store.getTree(parent.treeId);
    if (tree.status !== "active") {
      throw new Error(`tree ${tree.treeId} is not active (${tree.status})`);
    }
    if (tree.manifestDigest !== null) {
      if (parent.roleName === null) throw new Error(`manifest parent ${parent.nodeId} has no role identity`);
      const manifestRecord = this.store.getManifest(tree.manifestDigest);
      if (manifestRecord === null) throw new Error(`tree ${tree.treeId} manifest ${tree.manifestDigest} is missing`);
      const manifest = parseResolvedManifest(manifestRecord.resolved);
      const parentRole = getManifestRole(manifest, parent.roleName);
      if (!parentRole.capabilities.mergeChildren) {
        throw new Error(`role ${parentRole.name} is not authorized to merge child branches`);
      }
    }
    const child = this.store.getNode(input.childNodeId);
    if (child.treeId !== parent.treeId || child.parentNodeId !== parent.nodeId) {
      throw new Error(`node ${child.nodeId} is not a direct child of ${parent.nodeId}`);
    }
    if (child.placement !== "workspace") {
      throw new Error(`tab child ${child.nodeId} shares its parent worktree and must not be merged`);
    }
    if (child.lifecycleStatus !== "completed") {
      throw new Error(`child ${child.nodeId} is not completed`);
    }
    if (!(await isCleanWorktree(child.worktreePath))) {
      throw new Error(`child ${child.nodeId} worktree is dirty`);
    }
    const childCommitSha = await resolveCommit(child.worktreePath, "HEAD");
    const recordedChildCommit = this.store.getLatestCompletedStepCommit(child.nodeId);
    if (childCommitSha !== recordedChildCommit) {
      throw new Error(
        `child ${child.nodeId} HEAD ${childCommitSha} differs from completed step ${recordedChildCommit}`,
      );
    }
    const operationId = operationIdForRequest(parent.treeId, "merge", `${parent.nodeId}/${child.nodeId}`);
    const request = {
      parentNodeId: parent.nodeId,
      parentBranch: parent.branch,
      childNodeId: child.nodeId,
      childCommitSha,
    };
    let operation = this.store.reserveParentMergeOperation({
      operationId,
      treeId: parent.treeId,
      parentNodeId: parent.nodeId,
      childNodeId: child.nodeId,
      requestHash: requestHash(request),
      request,
    });
    const receipt = { operationId, childNodeId: child.nodeId, childCommitSha };
    if (operation.status === "completed") {
      return {
        operation,
        parentNodeId: parent.nodeId,
        childNodeId: child.nodeId,
        childCommitSha,
        mergeCommitSha: operationResultCommit(operation) ?? (await resolveCommit(parent.worktreePath, "HEAD")),
        duplicate: true,
        reconciled: false,
      };
    }
    if (operation.status === "blocked" || operation.status === "failed") {
      throw new MergeBlockedError(operation.lastError ?? `merge operation is ${operation.status}`);
    }
    if (operation.status === "submitted" || operation.status === "delivery_unknown") {
      const reconciledCommit = await this.findReceiptCommit(parent.worktreePath, receipt);
      if (reconciledCommit !== null) {
        operation = this.completeOperation(operation, parent.nodeId, child.nodeId, childCommitSha, reconciledCommit);
        return {
          operation,
          parentNodeId: parent.nodeId,
          childNodeId: child.nodeId,
          childCommitSha,
          mergeCommitSha: reconciledCommit,
          duplicate: true,
          reconciled: true,
        };
      }
      if (await hasMergeInProgress(parent.worktreePath)) {
        throw this.blockOperation(operation, `merge conflict is preserved in ${parent.worktreePath}`);
      }
      if (!(await isCleanWorktree(parent.worktreePath))) {
        throw this.blockOperation(operation, `parent ${parent.nodeId} worktree is dirty after uncertain merge`);
      }
      if (await commitExistsOnBranch(parent.worktreePath, childCommitSha, "HEAD")) {
        throw this.blockOperation(operation, `child commit is reachable without exact merge receipt ${operationId}`);
      }
    }
    if (!(await isCleanWorktree(parent.worktreePath))) {
      throw this.blockOperation(operation, `parent ${parent.nodeId} worktree must be clean before merge`);
    }
    operation = this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
    try {
      await runGit(parent.worktreePath, [
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `sheltie: merge child ${child.name}`,
        "-m",
        receiptLines(receipt).join("\n"),
        childCommitSha,
      ]);
      const mergeCommitSha = await resolveCommit(parent.worktreePath, "HEAD");
      const message = await runGit(parent.worktreePath, ["show", "-s", "--format=%B", mergeCommitSha]);
      if (!hasExactReceipt(message, receipt)) {
        throw new Error(`merge commit ${mergeCommitSha} is missing its exact Sheltie receipt`);
      }
      await this.options.failpoint?.("after_git_merge", operation.operationId);
      operation = this.completeOperation(operation, parent.nodeId, child.nodeId, childCommitSha, mergeCommitSha);
      return {
        operation,
        parentNodeId: parent.nodeId,
        childNodeId: child.nodeId,
        childCommitSha,
        mergeCommitSha,
        duplicate: false,
        reconciled: false,
      };
    } catch (error) {
      if (error instanceof MergeBlockedError) throw error;
      if (error instanceof CommandError && (await hasMergeInProgress(parent.worktreePath))) {
        throw this.blockOperation(operation, `merge conflict is preserved in ${parent.worktreePath}: ${error.stderr.trim()}`);
      }
      this.store.setOperationStatus(operation.operationId, "delivery_unknown", {
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private completeOperation(
    operation: OperationRecord,
    parentNodeId: string,
    childNodeId: string,
    childCommitSha: string,
    mergeCommitSha: string,
  ): OperationRecord {
    return this.store.setOperationStatus(operation.operationId, "completed", {
      result: { parentNodeId, childNodeId, childCommitSha, mergeCommitSha },
      lastError: null,
    });
  }

  private blockOperation(operation: OperationRecord, message: string): MergeBlockedError {
    this.store.setOperationStatus(operation.operationId, "blocked", { lastError: message });
    return new MergeBlockedError(message);
  }

  private async findReceiptCommit(worktreePath: string, receipt: MergeReceipt): Promise<string | null> {
    const candidates = await runGit(worktreePath, [
      "log",
      "--format=%H",
      "--fixed-strings",
      `--grep=Sheltie-Operation: ${receipt.operationId}`,
      "HEAD",
    ]);
    for (const commitSha of candidates.split("\n").filter((value) => value.length > 0)) {
      const message = await runGit(worktreePath, ["show", "-s", "--format=%B", commitSha]);
      if (
        hasExactReceipt(message, receipt) &&
        (await commitExistsOnBranch(worktreePath, receipt.childCommitSha, commitSha))
      ) {
        return commitSha;
      }
    }
    return null;
  }
}
