import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheltieStore } from "../src/db.ts";
import { commitAll, commitExistsOnBranch, hasMergeInProgress, initDisposableRepo, resolveCommit, runGit } from "../src/git.ts";
import { MergeBlockedError, MergeController } from "../src/merge.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface MergeFixture {
  store: SheltieStore;
  parentPath: string;
  childPath: string;
  childCommit: string;
}

async function createMergeFixture(options: { conflict?: boolean } = {}): Promise<MergeFixture> {
  const root = mkdtempSync(join(tmpdir(), "sheltie-merge-"));
  roots.push(root);
  const repoRoot = join(root, "repo");
  await initDisposableRepo(repoRoot);
  if (options.conflict === true) {
    writeFileSync(join(repoRoot, "shared.txt"), "base\n");
    await commitAll(repoRoot, "add shared base");
  }
  const baseCommit = await resolveCommit(repoRoot, "HEAD");
  const parentPath = join(root, "parent");
  const childPath = join(root, "child");
  await runGit(repoRoot, ["worktree", "add", "-b", "sheltie/parent", parentPath, baseCommit]);
  await runGit(repoRoot, ["worktree", "add", "-b", "sheltie/parent.child", childPath, baseCommit]);
  if (options.conflict === true) {
    writeFileSync(join(parentPath, "shared.txt"), "parent\n");
    await commitAll(parentPath, "change shared in parent");
    writeFileSync(join(childPath, "shared.txt"), "child\n");
  } else {
    writeFileSync(join(childPath, "child-result.txt"), "child complete\n");
  }
  const childCommit = await commitAll(childPath, "complete child");
  const store = new SheltieStore(join(root, "state.sqlite"));
  store.createTree({
    treeId: "tree-merge",
    runId: "run-merge",
    repoRoot,
    repoSourceWorkspaceId: "w-source",
    herdrSocketPath: join(root, "herdr.sock"),
    herdrVersion: "0.8.0",
    herdrProtocol: 20,
    baseCommit,
    worktreeRoot: root,
    rootTaskContract: "merge child",
    status: "active",
  });
  store.reserveNode({
    nodeId: "node-parent",
    treeId: "tree-merge",
    parentNodeId: null,
    name: "parent",
    depth: 0,
    branch: "sheltie/parent",
    baseCommit,
    worktreePath: parentPath,
    taskContract: "merge child",
  });
  store.bindWorktree("node-parent", { workspaceId: "w-parent", tabId: "w-parent:t1", paneId: "w-parent:p1" });
  store.reserveNode({
    nodeId: "node-child",
    treeId: "tree-merge",
    parentNodeId: "node-parent",
    name: "child",
    depth: 1,
    branch: "sheltie/parent.child",
    baseCommit,
    worktreePath: childPath,
    taskContract: "complete child",
  });
  store.bindWorktree("node-child", { workspaceId: "w-child", tabId: "w-child:t1", paneId: "w-child:p1" });
  store.reserveStep({
    operationId: "child-step",
    nodeId: "node-child",
    runNumber: 1,
    iterationNumber: 1,
    stepNumber: 1,
    promptSha256: "a".repeat(64),
  });
  store.claimStep("child-step", "w-child:p1");
  store.completeStep({
    operationId: "child-step",
    agentSession: "w-child:p1",
    commitSha: childCommit,
    resultMessageId: null,
  });
  store.setNodeLifecycle("node-child", "completed");
  return { store, parentPath, childPath, childCommit };
}

describe("MergeController", () => {
  test("merges a completed child commit from the parent worktree exactly once", async () => {
    const fixture = await createMergeFixture();
    const controller = new MergeController(fixture.store);

    const first = await controller.mergeChild({ parentPaneId: "w-parent:p1", childNodeId: "node-child" });
    const firstHead = await resolveCommit(fixture.parentPath, "HEAD");
    const replay = await controller.mergeChild({ parentPaneId: "w-parent:p1", childNodeId: "node-child" });

    expect(first.operation.status).toBe("completed");
    expect(first.childCommitSha).toBe(fixture.childCommit);
    expect(await commitExistsOnBranch(fixture.parentPath, fixture.childCommit, "HEAD")).toBe(true);
    expect(readFileSync(join(fixture.parentPath, "child-result.txt"), "utf8")).toBe("child complete\n");
    expect(replay.duplicate).toBe(true);
    expect(await resolveCommit(fixture.parentPath, "HEAD")).toBe(firstHead);
    fixture.store.close();
  });

  test("reconciles an exact merge receipt after the Git commit response is lost", async () => {
    const fixture = await createMergeFixture();
    let failpointArmed = true;
    const first = new MergeController(fixture.store, {
      failpoint: (name) => {
        if (name === "after_git_merge" && failpointArmed) {
          failpointArmed = false;
          throw new Error("merge response lost");
        }
      },
    });

    await expect(first.mergeChild({ parentPaneId: "w-parent:p1", childNodeId: "node-child" })).rejects.toThrow(
      "merge response lost",
    );
    const mergedHead = await resolveCommit(fixture.parentPath, "HEAD");
    expect(fixture.store.listUnresolvedOperations("tree-merge")).toHaveLength(1);

    const replay = await new MergeController(fixture.store).mergeChild({
      parentPaneId: "w-parent:p1",
      childNodeId: "node-child",
    });

    expect(replay.reconciled).toBe(true);
    expect(replay.operation.status).toBe("completed");
    expect(await resolveCommit(fixture.parentPath, "HEAD")).toBe(mergedHead);
    fixture.store.close();
  });

  test("blocks and preserves a conflicting parent worktree", async () => {
    const fixture = await createMergeFixture({ conflict: true });
    const controller = new MergeController(fixture.store);

    await expect(
      controller.mergeChild({ parentPaneId: "w-parent:p1", childNodeId: "node-child" }),
    ).rejects.toBeInstanceOf(MergeBlockedError);

    expect(fixture.store.listUnresolvedOperations("tree-merge")[0]?.status).toBe("blocked");
    expect(await hasMergeInProgress(fixture.parentPath)).toBe(true);
    expect(readFileSync(join(fixture.parentPath, "shared.txt"), "utf8")).toContain("<<<<<<<");
    fixture.store.close();
  });
});
