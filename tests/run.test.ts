import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheltieStore } from "../src/db.ts";
import { initDisposableRepo } from "../src/git.ts";
import type {
  PaneInfo,
  PongResult,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
  WorktreeInfo,
} from "../src/herdr-client.ts";
import { operationIdForRequest } from "../src/ids.ts";
import { RealRunController, type RunHerdrControl } from "../src/run.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pane(workspaceId: string, paneId: string): PaneInfo {
  return {
    pane_id: paneId,
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    agent_status: "idle",
  };
}

class FakeRunHerdr implements RunHerdrControl {
  workspaceCreateCalls = 0;
  snapshotValue: SessionSnapshot = {
    version: "0.8.0",
    protocol: 20,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
  };

  ping(): Promise<PongResult> {
    return Promise.resolve({ type: "pong", version: "0.8.0", protocol: 20, capabilities: null });
  }

  snapshot(): Promise<SessionSnapshot> {
    return Promise.resolve(this.snapshotValue);
  }

  workspaceCreate(params: { cwd: string; focus?: boolean; label?: string; env?: Record<string, string> }): Promise<{
    type: "workspace_created";
    workspace: WorkspaceInfo;
    tab: TabInfo;
    root_pane: PaneInfo;
  }> {
    this.workspaceCreateCalls += 1;
    const workspace: WorkspaceInfo = {
      workspace_id: "w-source",
      label: params.label ?? "source",
      focused: false,
      active_tab_id: "w-source:t1",
      worktree: {
        repo_root: params.cwd,
        checkout_path: params.cwd,
        is_linked_worktree: false,
      },
    };
    const tab = { workspace_id: "w-source", tab_id: "w-source:t1" };
    const rootPane = pane("w-source", "w-source:p1");
    this.snapshotValue = {
      ...this.snapshotValue,
      workspaces: [workspace],
      tabs: [tab],
      panes: [rootPane],
    };
    return Promise.resolve({ type: "workspace_created", workspace, tab, root_pane: rootPane });
  }

  worktreeList(): Promise<{
    type: "worktree_list";
    source: { repo_root: string; source_workspace_id?: string };
    worktrees: WorktreeInfo[];
  }> {
    return Promise.resolve({
      type: "worktree_list",
      source: { repo_root: "/tmp/repo", source_workspace_id: "w-source" },
      worktrees: [],
    });
  }

  worktreeCreate(): Promise<never> {
    return Promise.reject(new Error("worktreeCreate was not expected"));
  }

  agentStart(): Promise<never> {
    return Promise.reject(new Error("agentStart was not expected"));
  }

  agentGet(): Promise<never> {
    return Promise.reject(new Error("agentGet was not expected"));
  }

  agentPrompt(): Promise<never> {
    return Promise.reject(new Error("agentPrompt was not expected"));
  }
}

describe("RealRunController", () => {
  test("rebinds a response-lost source workspace before reserving one root node", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-"));
    roots.push(root);
    const repoRoot = join(root, "repo");
    await initDisposableRepo(repoRoot);
    const databasePath = join(root, "state.sqlite");
    const fake = new FakeRunHerdr();
    const store = new SheltieStore(databasePath);
    let failpointArmed = true;
    const first = new RealRunController(store, fake, {
      sheltieExecutable: "/opt/sheltie",
      failpoint: (name) => {
        if (name === "before_source_workspace_response_persist" && failpointArmed) {
          failpointArmed = false;
          throw new Error("source response lost");
        }
      },
    });

    await expect(
      first.startRun({
        runId: "run-real-1",
        repoRoot,
        base: "HEAD",
        worktreeRoot: join(root, "worktrees"),
        taskContract: "create result.txt and finish the node",
        herdrSocketPath: join(root, "herdr.sock"),
      }),
    ).rejects.toThrow("source response lost");
    expect(fake.workspaceCreateCalls).toBe(1);
    expect(store.getOnlyTree()).toMatchObject({
      repoSourceWorkspaceId: null,
      status: "initializing",
    });
    store.close();

    const restoredStore = new SheltieStore(databasePath);
    const restored = new RealRunController(restoredStore, fake, { sheltieExecutable: "/opt/sheltie" });
    const tree = await restored.resumeBootstrap();

    expect(fake.workspaceCreateCalls).toBe(1);
    expect(tree).toMatchObject({ repoSourceWorkspaceId: "w-source", status: "active" });
    expect(restoredStore.listNodes(tree.treeId)).toHaveLength(1);
    expect(restoredStore.findRootNode(tree.treeId)).toMatchObject({
      parentNodeId: null,
      taskContract: "create result.txt and finish the node",
      baseCommit: tree.baseCommit,
    });
    expect(restoredStore.listUnresolvedOperations(tree.treeId)).toEqual([]);
    restoredStore.close();
  });

  test("marks the tree completed only after its root node is explicitly finished", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-complete-"));
    roots.push(root);
    const store = new SheltieStore(join(root, "state.sqlite"));
    store.createTree({
      treeId: "tree-real",
      runId: "run-real",
      repoRoot: join(root, "repo"),
      repoSourceWorkspaceId: "w-source",
      herdrSocketPath: join(root, "herdr.sock"),
      herdrVersion: "0.8.0",
      herdrProtocol: 20,
      baseCommit: "a".repeat(40),
      worktreeRoot: join(root, "worktrees"),
      rootTaskContract: "finish root",
      status: "active",
    });
    store.reserveNode({
      nodeId: "node-root",
      treeId: "tree-real",
      parentNodeId: null,
      name: "root",
      depth: 0,
      branch: "sheltie/run-real-root",
      baseCommit: "a".repeat(40),
      worktreePath: join(root, "worktrees", "root"),
      taskContract: "finish root",
    });
    store.bindWorktree("node-root", { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1" });
    store.bindAgent("node-root", {
      agentName: "s-node-root",
      terminalId: "terminal-node-root",
      agentInstanceId: "instance-node-root",
    });
    const promptOperationId = operationIdForRequest("tree-real", "prompt", "node-root/step/initial");
    store.reserveOperation({
      operationId: promptOperationId,
      treeId: "tree-real",
      nodeId: "node-root",
      kind: "prompt",
      requestKey: "node-root/step/initial",
      requestHash: "prompt-request",
      request: { target: "s-node-root" },
    });
    store.setOperationStatus(promptOperationId, "observed");
    store.reserveStep({
      operationId: promptOperationId,
      nodeId: "node-root",
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256: "b".repeat(64),
    });
    store.claimStep(promptOperationId, "w2:p1");
    store.completeStep({
      operationId: promptOperationId,
      agentSession: "w2:p1",
      commitSha: "c".repeat(40),
      resultMessageId: null,
    });
    const controller = new RealRunController(store, new FakeRunHerdr(), { sheltieExecutable: "/opt/sheltie" });

    expect((await controller.convergeOnce()).tree.status).toBe("active");
    store.finishNode("node-root", "w2:p1");
    expect((await controller.convergeOnce()).tree.status).toBe("completed");
    store.close();
  });
});
