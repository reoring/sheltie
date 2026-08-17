import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CleanupController,
  type CleanupHerdrControl,
  type CleanupPlan,
} from "../src/cleanup.ts";
import { SheltieStore } from "../src/db.ts";
import {
  commitAll,
  initDisposableRepo,
  resolveCommit,
  runGit,
} from "../src/git.ts";
import type {
  AgentInfo,
  PaneInfo,
  PongResult,
  SessionSnapshot,
  WorktreeInfo,
  WorkspaceInfo,
} from "../src/herdr-client.ts";

const roots: string[] = [];

const MANIFEST_A = "a".repeat(64);
const MANIFEST_B = "b".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(
  workspaceId: string,
  label: string,
  repoRoot: string,
  checkoutPath: string,
  linked: boolean,
): WorkspaceInfo {
  return {
    workspace_id: workspaceId,
    label,
    focused: false,
    active_tab_id: `${workspaceId}:t1`,
    worktree: {
      repo_root: repoRoot,
      checkout_path: checkoutPath,
      is_linked_worktree: linked,
    },
  };
}

function pane(workspaceId: string): PaneInfo {
  return {
    pane_id: `${workspaceId}:p1`,
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    agent_status: "done",
  };
}

class FakeCleanupHerdr implements CleanupHerdrControl {
  readonly calls: string[] = [];
  readonly unrelatedWorkspaceId = "w-unrelated";
  snapshotValue: SessionSnapshot;
  worktrees: WorktreeInfo[];
  worktreeListSource: { repo_root: string; source_workspace_id?: string };

  constructor(
    readonly repoRoot: string,
    childPath: string,
  ) {
    const workspaces = [
      workspace("w-root", "root", repoRoot, repoRoot, false),
      workspace("w-child", "child", repoRoot, childPath, true),
      workspace(this.unrelatedWorkspaceId, "unrelated", "/tmp/unrelated", "/tmp/unrelated", false),
    ];
    this.snapshotValue = {
      version: "0.8.0",
      protocol: 20,
      workspaces,
      tabs: workspaces.map((candidate) => ({
        workspace_id: candidate.workspace_id,
        tab_id: `${candidate.workspace_id}:t1`,
      })),
      panes: workspaces.map((candidate) => pane(candidate.workspace_id)),
      agents: [],
    };
    this.worktrees = [
      {
        path: childPath,
        branch: "sheltie/run-root.child",
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        open_workspace_id: "w-child",
        label: "child",
      },
    ];
    this.worktreeListSource = { repo_root: repoRoot, source_workspace_id: "w-root" };
  }

  ping(): Promise<PongResult> {
    return Promise.resolve({ type: "pong", version: "0.8.0", protocol: 20, capabilities: null });
  }

  snapshot(): Promise<SessionSnapshot> {
    return Promise.resolve(structuredClone(this.snapshotValue));
  }

  worktreeList(): Promise<{
    type: "worktree_list";
    source: { repo_root: string; source_workspace_id?: string };
    worktrees: WorktreeInfo[];
  }> {
    return Promise.resolve({
      type: "worktree_list",
      source: { ...this.worktreeListSource },
      worktrees: structuredClone(this.worktrees),
    });
  }

  async worktreeRemove(params: { workspace_id: string; force: boolean }): Promise<{
    type: "worktree_removed";
    workspace_id: string;
    path: string;
    forced: boolean;
  }> {
    expect(params.force).toBe(false);
    const workspaceInfo = this.snapshotValue.workspaces.find(
      (candidate) => candidate.workspace_id === params.workspace_id,
    );
    if (workspaceInfo?.worktree === undefined) throw new Error(`workspace ${params.workspace_id} not found`);
    const path = workspaceInfo.worktree.checkout_path;
    await runGit(this.repoRoot, ["worktree", "remove", path]);
    this.calls.push(`remove:${params.workspace_id}`);
    this.removeWorkspace(params.workspace_id);
    this.worktrees = this.worktrees.filter((candidate) => candidate.path !== path);
    return {
      type: "worktree_removed",
      workspace_id: params.workspace_id,
      path,
      forced: false,
    };
  }

  workspaceClose(params: { workspace_id: string }): Promise<{ type: "ok" }> {
    if (!this.snapshotValue.workspaces.some((candidate) => candidate.workspace_id === params.workspace_id)) {
      return Promise.reject(new Error(`workspace ${params.workspace_id} not found`));
    }
    this.calls.push(`close:${params.workspace_id}`);
    this.removeWorkspace(params.workspace_id);
    return Promise.resolve({ type: "ok" });
  }

  private removeWorkspace(workspaceId: string): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      workspaces: this.snapshotValue.workspaces.filter((candidate) => candidate.workspace_id !== workspaceId),
      tabs: this.snapshotValue.tabs.filter((candidate) => candidate.workspace_id !== workspaceId),
      panes: this.snapshotValue.panes.filter((candidate) => candidate.workspace_id !== workspaceId),
      agents: this.snapshotValue.agents.filter((candidate) => candidate.workspace_id !== workspaceId),
    };
  }
}

interface Fixture {
  root: string;
  repoRoot: string;
  rootPath: string;
  childPath: string;
  rootHead: string;
  childHead: string;
  store: SheltieStore;
  herdr: FakeCleanupHerdr;
}

async function createFixture(manifestDigest: string | null = null): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "sheltie-cleanup-"));
  roots.push(root);
  const repoRoot = join(root, "repo");
  await initDisposableRepo(repoRoot);
  const rootPath = repoRoot;
  const childPath = join(root, "worktrees", "child");
  const baseCommit = await resolveCommit(repoRoot, "main");
  await runGit(repoRoot, ["switch", "-c", "sheltie/run-root", baseCommit]);
  await runGit(repoRoot, [
    "worktree",
    "add",
    "-b",
    "sheltie/run-root.child",
    childPath,
    "sheltie/run-root",
  ]);
  writeFileSync(join(childPath, "child.txt"), "child result\n");
  const childHead = await commitAll(childPath, "child result");
  await runGit(rootPath, ["merge", "--no-ff", "--no-edit", childHead]);
  const rootHead = await resolveCommit(rootPath, "HEAD");

  const store = new SheltieStore(join(root, "state.sqlite"));
  store.createTree({
    treeId: "tree-cleanup",
    runId: "run-cleanup",
    repoRoot,
    repoSourceWorkspaceId: "w-root",
    herdrSocketPath: join(root, "herdr.sock"),
    herdrVersion: "0.8.0",
    herdrProtocol: 20,
    baseCommit,
    worktreeRoot: join(root, "worktrees"),
    rootTaskContract: "produce a root branch",
    status: "completed",
    manifestDigest,
  });
  store.reserveNode({
    nodeId: "node-root",
    treeId: "tree-cleanup",
    parentNodeId: null,
    name: "root",
    depth: 0,
    branch: "sheltie/run-root",
    baseCommit,
    worktreePath: repoRoot,
    taskContract: "root",
  });
  store.bindWorktree("node-root", {
    workspaceId: "w-root",
    tabId: "w-root:t1",
    paneId: "w-root:p1",
  });
  store.bindAgent("node-root", {
    agentName: "s-root",
    terminalId: "terminal-root",
    agentInstanceId: "instance-root",
  });
  store.setNodeLifecycle("node-root", "completed");
  store.reserveNode({
    nodeId: "node-child",
    treeId: "tree-cleanup",
    parentNodeId: "node-root",
    name: "child",
    depth: 1,
    branch: "sheltie/run-root.child",
    baseCommit,
    worktreePath: childPath,
    taskContract: "child",
  });
  store.bindWorktree("node-child", {
    workspaceId: "w-child",
    tabId: "w-child:t1",
    paneId: "w-child:p1",
  });
  store.bindAgent("node-child", {
    agentName: "s-child",
    terminalId: "terminal-child",
    agentInstanceId: "instance-child",
  });
  store.setNodeLifecycle("node-child", "completed");
  const merge = store.reserveParentMergeOperation({
    operationId: "merge-child",
    treeId: "tree-cleanup",
    parentNodeId: "node-root",
    childNodeId: "node-child",
    requestHash: "merge-child-request",
    request: { childNodeId: "node-child", childCommitSha: childHead },
  });
  store.setOperationStatus(merge.operationId, "completed", {
    result: {
      parentNodeId: "node-root",
      childNodeId: "node-child",
      childCommitSha: childHead,
      mergeCommitSha: rootHead,
    },
  });

  return {
    root,
    repoRoot,
    rootPath,
    childPath,
    rootHead,
    childHead,
    store,
    herdr: new FakeCleanupHerdr(repoRoot, childPath),
  };
}

function findAction(plan: CleanupPlan, kind: CleanupPlan["actions"][number]["kind"]): number {
  return plan.actions.findIndex((action) => action.kind === kind);
}

describe("CleanupController", () => {
  test("previews exact targets without mutation and applies leaf-to-root while retaining the root branch", async () => {
    const fixture = await createFixture();
    fixture.store.reserveNode({
      nodeId: "node-reviewer",
      treeId: "tree-cleanup",
      parentNodeId: "node-root",
      name: "reviewer",
      depth: 1,
      placement: "tab",
      branch: "sheltie/run-root",
      baseCommit: fixture.rootHead,
      worktreePath: fixture.rootPath,
      taskContract: "review only",
    });
    fixture.store.bindWorktree("node-reviewer", {
      workspaceId: "w-root",
      tabId: "w-root:t2",
      paneId: "w-root:p2",
    });
    fixture.store.bindAgent("node-reviewer", {
      agentName: "s-reviewer",
      terminalId: "terminal-reviewer",
      agentInstanceId: "instance-reviewer",
    });
    fixture.store.setNodeLifecycle("node-reviewer", "completed");
    fixture.store.sendMessage({
      messageId: "message-reviewer",
      treeId: "tree-cleanup",
      senderNodeId: "node-reviewer",
      recipientNodeId: "node-root",
      channel: "inbox",
      kind: "progress",
      priority: 5,
      replyToMessageId: null,
      body: "review complete",
    });
    fixture.herdr.snapshotValue.tabs.push({
      workspace_id: "w-root",
      tab_id: "w-root:t2",
      label: "reviewer",
    });
    fixture.herdr.snapshotValue.panes.push({
      workspace_id: "w-root",
      tab_id: "w-root:t2",
      pane_id: "w-root:p2",
      cwd: fixture.rootPath,
      agent_status: "done",
    });
    const controller = new CleanupController(fixture.store, fixture.herdr);

    const plan = await controller.preview();

    expect(plan.blockers).toEqual([]);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan).toMatchObject({
      schemaVersion: 2,
      manifestDigest: null,
      runId: "run-cleanup",
      treeGeneration: fixture.store.getOnlyTree().generation,
      herdrSocketPath: join(fixture.root, "herdr.sock"),
      workspaceIds: ["w-child", "w-root"],
      paneIds: ["w-child:p1", "w-root:p1", "w-root:p2"],
      terminalIds: ["terminal-child", "terminal-reviewer", "terminal-root"],
      worktreePaths: [fixture.childPath],
      branchNames: ["sheltie/run-root.child", "sheltie/run-root"],
      headCommitShas: [fixture.childHead, fixture.rootHead],
      mergeReceiptIds: ["merge-child"],
    });
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "remove_worktree",
      "delete_child_branch",
      "close_source_workspace",
    ]);
    expect(findAction(plan, "remove_worktree")).toBe(0);
    expect(fixture.herdr.calls).toEqual([]);
    expect(existsSync(fixture.rootPath)).toBe(true);
    expect(existsSync(fixture.childPath)).toBe(true);
    expect(await resolveCommit(fixture.repoRoot, "sheltie/run-root")).toBe(fixture.rootHead);
    expect(await resolveCommit(fixture.repoRoot, "sheltie/run-root.child")).toBe(fixture.childHead);
    await expect(controller.apply()).rejects.toThrow("--plan-digest is required");

    const result = await controller.apply(plan.planDigest);

    expect(result.duplicate).toBe(false);
    expect(result.tree.status).toBe("cleaned");
    expect(fixture.herdr.calls).toEqual(["remove:w-child", "close:w-root"]);
    expect(existsSync(fixture.childPath)).toBe(false);
    expect(existsSync(fixture.rootPath)).toBe(true);
    expect(await resolveCommit(fixture.repoRoot, "sheltie/run-root")).toBe(fixture.rootHead);
    await expect(resolveCommit(fixture.repoRoot, "sheltie/run-root.child")).rejects.toThrow();
    expect(fixture.herdr.snapshotValue.workspaces.map((candidate) => candidate.workspace_id)).toEqual([
      fixture.herdr.unrelatedWorkspaceId,
    ]);
    expect(fixture.herdr.snapshotValue.panes.map((candidate) => candidate.workspace_id)).toEqual([
      fixture.herdr.unrelatedWorkspaceId,
    ]);
    expect(fixture.store.listCleanupReceipts(plan.planDigest)).toHaveLength(3);
    expect(fixture.store.listMessages("tree-cleanup").map((message) => message.body)).toEqual(["review complete"]);
    fixture.store.close();
  });

  test("accepts a protocol-20 source workspace without optional snapshot worktree metadata", async () => {
    const fixture = await createFixture();
    fixture.herdr.snapshotValue.workspaces = fixture.herdr.snapshotValue.workspaces.map((candidate) => {
      if (candidate.workspace_id !== "w-root") return candidate;
      const { worktree: _worktree, ...sourceWithoutWorktree } = candidate;
      return sourceWithoutWorktree;
    });
    const controller = new CleanupController(fixture.store, fixture.herdr);
    const plan = await controller.preview();

    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "close_source_workspace",
        workspaceId: "w-root",
        repoRoot: fixture.repoRoot,
      }),
    );
    await expect(controller.apply(plan.planDigest)).resolves.toMatchObject({
      tree: { status: "cleaned" },
    });
    fixture.store.close();
  });

  test("blocks a present source workspace with mismatched worktree metadata", async () => {
    const fixture = await createFixture();
    fixture.herdr.snapshotValue.workspaces = fixture.herdr.snapshotValue.workspaces.map((candidate) =>
      candidate.workspace_id === "w-root"
        ? {
            ...candidate,
            worktree: {
              repo_root: "/wrong/repository",
              checkout_path: fixture.repoRoot,
              is_linked_worktree: false,
            },
          }
        : candidate,
    );
    const plan = await new CleanupController(fixture.store, fixture.herdr).preview();

    expect(plan.blockers).toContain("DB repository source workspace does not match Herdr snapshot");
    fixture.store.close();
  });

  test("blocks a present linked source workspace worktree", async () => {
    const fixture = await createFixture();
    fixture.herdr.snapshotValue.workspaces = fixture.herdr.snapshotValue.workspaces.map((candidate) =>
      candidate.workspace_id === "w-root"
        ? {
            ...candidate,
            worktree: {
              repo_root: fixture.repoRoot,
              checkout_path: fixture.repoRoot,
              is_linked_worktree: true,
            },
          }
        : candidate,
    );
    const plan = await new CleanupController(fixture.store, fixture.herdr).preview();

    expect(plan.blockers).toContain("DB repository source workspace does not match Herdr snapshot");
    fixture.store.close();
  });

  test("blocks cleanup when the worktree-list source does not attest the source workspace", async () => {
    const fixture = await createFixture();
    fixture.herdr.worktreeListSource = {
      repo_root: fixture.repoRoot,
      source_workspace_id: "w-other",
    };
    const plan = await new CleanupController(fixture.store, fixture.herdr).preview();

    expect(plan.blockers).toContain("DB repository source identity does not match Herdr worktree source");
    fixture.store.close();
  });

  test("blocks cleanup when the root space contains an unowned tab or pane", async () => {
    const fixture = await createFixture();
    fixture.herdr.snapshotValue.tabs.push({
      workspace_id: "w-root",
      tab_id: "w-root:t-unowned",
      label: "manual",
    });
    fixture.herdr.snapshotValue.panes.push({
      workspace_id: "w-root",
      tab_id: "w-root:t-unowned",
      pane_id: "w-root:p-unowned",
      cwd: fixture.repoRoot,
      agent_status: "done",
    });
    const controller = new CleanupController(fixture.store, fixture.herdr);

    const plan = await controller.preview();

    expect(plan.blockers.join("\n")).toContain("root workspace w-root contains a pane not owned by this run");
    expect(plan.blockers.join("\n")).toContain("root workspace w-root contains a tab not owned by this run");
    await expect(controller.apply(plan.planDigest)).rejects.toThrow("cleanup is blocked");
    expect(fixture.herdr.calls).toEqual([]);
    expect(existsSync(fixture.repoRoot)).toBe(true);
    expect(existsSync(fixture.childPath)).toBe(true);
    fixture.store.close();
  });

  test("fails closed without changing dirty, conflicted, active, unresolved, or ownership-mismatched runs", async () => {
    const fixture = await createFixture();
    writeFileSync(join(fixture.childPath, "dirty.txt"), "preserve me\n");
    const mergeHeadPath = await runGit(fixture.rootPath, ["rev-parse", "--git-path", "MERGE_HEAD"]);
    writeFileSync(resolve(fixture.rootPath, mergeHeadPath), `${fixture.childHead}\n`);
    fixture.store.setTreeStatus("tree-cleanup", "active");
    fixture.store.reserveOperation({
      operationId: "unresolved-prompt",
      treeId: "tree-cleanup",
      nodeId: "node-root",
      kind: "prompt",
      requestKey: "unresolved",
      requestHash: "unresolved",
      request: {},
    });
    const activeAgent: AgentInfo = {
      terminal_id: "terminal-child",
      agent_instance_id: "instance-child",
      name: "s-child",
      agent_status: "idle",
      workspace_id: "w-child",
      tab_id: "w-child:t1",
      pane_id: "w-child:p1",
      launch_pending: false,
      interactive_ready: true,
    };
    fixture.herdr.snapshotValue.agents = [activeAgent];
    fixture.herdr.worktrees[0] = { ...fixture.herdr.worktrees[0]!, branch: "wrong-branch" };
    const controller = new CleanupController(fixture.store, fixture.herdr);

    const plan = await controller.preview();

    expect(plan.blockers.join("\n")).toContain("tree status active");
    expect(plan.blockers.join("\n")).toContain("active agent");
    expect(plan.blockers.join("\n")).toContain("unresolved operation");
    expect(plan.blockers.join("\n")).toContain("dirty worktree");
    expect(plan.blockers.join("\n")).toContain("MERGE_HEAD");
    expect(plan.blockers.join("\n")).toContain("Herdr worktree identity");
    await expect(controller.apply(plan.planDigest)).rejects.toThrow("cleanup is blocked");
    fixture.store.setTreeStatus("tree-cleanup", "cancelling");
    expect((await controller.preview()).blockers.join("\n")).toContain("tree status cancelling");
    expect(fixture.herdr.calls).toEqual([]);
    expect(existsSync(join(fixture.childPath, "dirty.txt"))).toBe(true);
    expect(existsSync(fixture.rootPath)).toBe(true);
    expect(existsSync(fixture.childPath)).toBe(true);
    fixture.store.close();
  });

  test("preserves a child branch that gained an unmerged commit after its merge receipt", async () => {
    const fixture = await createFixture();
    writeFileSync(join(fixture.childPath, "unmerged.txt"), "not in parent\n");
    const unmergedHead = await commitAll(fixture.childPath, "unmerged child result");
    const controller = new CleanupController(fixture.store, fixture.herdr);

    const plan = await controller.preview();

    expect(plan.blockers.join("\n")).toContain(
      `child commit ${unmergedHead} is not merged into parent branch sheltie/run-root`,
    );
    expect(
      plan.actions.some(
        (action) => action.kind === "delete_child_branch" && action.branch === "sheltie/run-root.child",
      ),
    ).toBe(false);
    await expect(controller.apply(plan.planDigest)).rejects.toThrow("cleanup is blocked");
    expect(existsSync(fixture.childPath)).toBe(true);
    expect(await resolveCommit(fixture.repoRoot, "sheltie/run-root.child")).toBe(unmergedHead);
    fixture.store.close();
  });

  test("rejects stale generations, changed heads, and mismatched digests before mutation", async () => {
    const generationFixture = await createFixture();
    const generationController = new CleanupController(generationFixture.store, generationFixture.herdr);
    const generationPlan = await generationController.preview();
    generationFixture.store.setTreeStatus("tree-cleanup", "failed");
    generationFixture.store.setTreeStatus("tree-cleanup", "completed");
    await expect(generationController.apply(generationPlan.planDigest)).rejects.toThrow("plan digest mismatch");
    expect(generationFixture.herdr.calls).toEqual([]);
    generationFixture.store.close();

    const headFixture = await createFixture();
    const headController = new CleanupController(headFixture.store, headFixture.herdr);
    const headPlan = await headController.preview();
    writeFileSync(join(headFixture.rootPath, "after-preview.txt"), "changed head\n");
    await commitAll(headFixture.rootPath, "change after preview");
    await expect(headController.apply(headPlan.planDigest)).rejects.toThrow("plan digest mismatch");
    expect(headFixture.herdr.calls).toEqual([]);
    await expect(headController.apply("0".repeat(64))).rejects.toThrow("plan digest mismatch");
    headFixture.store.close();
  });

  test("reconciles a response-lost removal and makes repeated v2 apply a receipt-backed no-op", async () => {
    const fixture = await createFixture(MANIFEST_A);
    let failOnce = true;
    const first = new CleanupController(fixture.store, fixture.herdr, {
      failpoint: (name, action) => {
        if (failOnce && name === "after_action_before_receipt" && action.kind === "remove_worktree") {
          failOnce = false;
          throw new Error("cleanup response lost");
        }
      },
    });
    const plan = await first.preview();

    expect(plan).toMatchObject({ schemaVersion: 2, manifestDigest: MANIFEST_A });

    await expect(first.apply(plan.planDigest)).rejects.toThrow("cleanup response lost");
    expect(existsSync(fixture.childPath)).toBe(false);
    expect(fixture.store.getCleanupPlan(plan.planDigest)?.status).toBe("applying");

    const restored = new CleanupController(fixture.store, fixture.herdr);
    const resumed = await restored.apply(plan.planDigest);
    const duplicate = await restored.apply(plan.planDigest);

    expect(resumed.duplicate).toBe(false);
    expect(resumed.tree.status).toBe("cleaned");
    expect(resumed.plan).toEqual(plan);
    expect(duplicate.plan).toEqual(plan);
    expect(duplicate.duplicate).toBe(true);
    expect(fixture.herdr.calls).toEqual(["remove:w-child", "close:w-root"]);
    expect(fixture.store.listCleanupReceipts(plan.planDigest).map((receipt) => receipt.actionIndex)).toEqual([
      0,
      1,
      2,
    ]);
    fixture.store.close();
  });

  test("binds a v2 preview digest to its manifest and rejects manifest drift before mutation", async () => {
    const fixture = await createFixture(MANIFEST_A);
    const controller = new CleanupController(fixture.store, fixture.herdr);
    const plan = await controller.preview();
    fixture.store.createCleanupPlan({
      planDigest: plan.planDigest,
      treeId: plan.treeId,
      treeGeneration: plan.treeGeneration,
      manifestDigest: plan.manifestDigest,
      plan,
    });

    const database = new Database(fixture.store.path, { strict: true });
    try {
      database.query("UPDATE trees SET manifest_digest = ? WHERE tree_id = ?").run(MANIFEST_B, plan.treeId);
    } finally {
      database.close();
    }
    const changedPlan = await controller.preview();

    expect(changedPlan).toMatchObject({ schemaVersion: 2, manifestDigest: MANIFEST_B });
    expect(changedPlan.planDigest).not.toBe(plan.planDigest);
    await expect(controller.apply(plan.planDigest)).rejects.toThrow("record does not match its payload and tree");
    expect(fixture.herdr.calls).toEqual([]);
    expect(existsSync(fixture.rootPath)).toBe(true);
    expect(existsSync(fixture.childPath)).toBe(true);
    expect(await resolveCommit(fixture.repoRoot, "sheltie/run-root")).toBe(fixture.rootHead);
    expect(await resolveCommit(fixture.repoRoot, "sheltie/run-root.child")).toBe(fixture.childHead);
    fixture.store.close();
  });

  test("rejects a persisted cleanup record whose manifest identity differs from its payload", async () => {
    const fixture = await createFixture(MANIFEST_A);
    const controller = new CleanupController(fixture.store, fixture.herdr);
    const plan = await controller.preview();
    fixture.store.createCleanupPlan({
      planDigest: plan.planDigest,
      treeId: plan.treeId,
      treeGeneration: plan.treeGeneration,
      manifestDigest: plan.manifestDigest,
      plan,
    });

    const database = new Database(fixture.store.path, { strict: true });
    try {
      database
        .query("UPDATE cleanup_plans SET manifest_digest = ? WHERE plan_digest = ?")
        .run(MANIFEST_B, plan.planDigest);
    } finally {
      database.close();
    }

    await expect(controller.apply(plan.planDigest)).rejects.toThrow("record does not match its payload and tree");
    expect(fixture.herdr.calls).toEqual([]);
    expect(existsSync(fixture.childPath)).toBe(true);
    fixture.store.close();
  });

  test("fails closed for a legacy v1 cleanup plan without creating a digest alias", async () => {
    const fixture = await createFixture();
    const controller = new CleanupController(fixture.store, fixture.herdr);
    const plan = await controller.preview();
    const { manifestDigest: legacyManifestDigest, ...legacyPlan } = { ...plan, schemaVersion: 1 as const };
    expect(legacyManifestDigest).toBeNull();
    const database = new Database(fixture.store.path, { strict: true });
    try {
      database
        .query(`INSERT INTO cleanup_plans (
          plan_digest, tree_id, tree_generation, manifest_digest, plan_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'applying', ?, ?)`)
        .run(
          plan.planDigest,
          plan.treeId,
          plan.treeGeneration,
          null,
          JSON.stringify(legacyPlan),
          Date.now(),
          Date.now(),
        );
    } finally {
      database.close();
    }

    await expect(controller.apply(plan.planDigest)).rejects.toThrow("unsupported cleanup plan schema");
    expect(fixture.store.getCleanupPlan(plan.planDigest)?.plan).not.toHaveProperty("manifestDigest");
    expect(fixture.herdr.calls).toEqual([]);
    expect(existsSync(fixture.childPath)).toBe(true);
    fixture.store.close();
  });
});
