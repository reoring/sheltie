import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheltieStore } from "../src/db.ts";
import { commitAll, commitExistsOnBranch, hasMergeInProgress, initDisposableRepo, resolveCommit, runGit } from "../src/git.ts";
import { MergeBlockedError, MergeController } from "../src/merge.ts";
import { resolveManifestFile } from "../src/manifest.ts";

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

async function createMergeFixture(options: { conflict?: boolean; mergeCapability?: boolean } = {}): Promise<MergeFixture> {
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
  const manifestPath = join(root, "sheltie.yaml");
  writeFileSync(manifestPath, `apiVersion: sheltie.dev/v1alpha1
kind: Run
metadata:
  name: merge-test
spec:
  root:
    role: parent
    name: parent
  limits:
    maxDepth: 4
    maxChildrenPerNode: 8
    maxDescendants: 32
    maxParallelNodes: 8
  roles:
    parent:
      placement: workspace
      agent:
        kind: omp
      prompt:
        inline: |
          merge child
      capabilities:
        spawn:
          roles: [child]
        mergeChildren: ${options.mergeCapability ?? true}
        messaging:
          sendTo: [children]
          receiveFrom: [children]
    child:
      placement: workspace
      agent:
        kind: omp
      prompt:
        inline: |
          complete child
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent]
`);
  const manifest = resolveManifestFile(manifestPath);
  const store = new SheltieStore(join(root, "state.sqlite"));
  store.saveManifest({
    manifestDigest: manifest.digest,
    apiVersion: manifest.manifest.apiVersion,
    resolved: manifest.manifest,
  });
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
    manifestDigest: manifest.digest,
    rootRole: "parent",
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
    roleName: "parent",
    roleDigest: manifest.manifest.spec.roles.parent!.digest,
    parameters: {},
    resolvedCapabilities: manifest.manifest.spec.roles.parent!.capabilities,
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
    roleName: "child",
    roleDigest: manifest.manifest.spec.roles.child!.digest,
    parameters: {},
    resolvedCapabilities: manifest.manifest.spec.roles.child!.capabilities,
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

  test("rejects merge when the parent role lacks merge capability", async () => {
    const fixture = await createMergeFixture({ mergeCapability: false });
    const before = await resolveCommit(fixture.parentPath, "HEAD");

    await expect(
      new MergeController(fixture.store).mergeChild({
        parentPaneId: "w-parent:p1",
        childNodeId: "node-child",
      }),
    ).rejects.toThrow("role parent is not authorized to merge child branches");

    expect(await resolveCommit(fixture.parentPath, "HEAD")).toBe(before);
    expect(fixture.store.listOperations("tree-merge").filter((operation) => operation.kind === "merge")).toEqual([]);
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
