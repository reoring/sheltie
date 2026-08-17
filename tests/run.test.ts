import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheltieStore, type TreeRecord } from "../src/db.ts";
import { commitAll, initDisposableRepo, resolveCommit, runGit } from "../src/git.ts";
import type {
  AgentInfo,
  PaneInfo,
  PongResult,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
  WorktreeInfo,
} from "../src/herdr-client.ts";
import { branchForNode, operationIdForRequest, requestHash } from "../src/ids.ts";
import { RealRunController, type RunHerdrControl } from "../src/run.ts";
import { resolveManifestFile } from "../src/manifest.ts";
import {
  REQUIRED_V0_HERDR_SOURCE_COMMIT,
  REQUIRED_V0_OMP_SOURCE_COMMIT,
  parseRuntimeBinding,
  type BundledRuntimeBinding,
} from "../src/runtime-bundle.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createManifest(root: string) {
  const path = join(root, "sheltie.yaml");
  writeFileSync(path, `apiVersion: sheltie.dev/v1alpha1
kind: Run
metadata:
  name: run-test
spec:
  root:
    role: coordinator
    name: root
  limits:
    maxDepth: 4
    maxChildrenPerNode: 8
    maxDescendants: 32
    maxParallelNodes: 8
  roles:
    coordinator:
      placement: workspace
      agent:
        kind: omp
      prompt:
        inline: |
          create result.txt and finish the node
      capabilities:
        spawn:
          roles: [team]
        mergeChildren: true
        messaging:
          sendTo: [children]
          receiveFrom: [children]
    team:
      placement: workspace
      agent:
        kind: omp
      prompt:
        inline: |
          create the team result
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent]
`);
  return resolveManifestFile(path);
}

function bundledBinding(root: string): BundledRuntimeBinding {
  const bundleRoot = join(root, "bundle");
  const configHome = join(root, "runtime");
  const sessionName = `s-${"a".repeat(16)}`;
  const binding = parseRuntimeBinding({
    mode: "bundled",
    bundleRoot,
    bundleDigest: "a".repeat(64),
    bundleTarget: "linux-x64",
    sessionName,
    configHome,
    socketPath: join(configHome, "herdr", "sessions", sessionName, "herdr.sock"),
    pathPrefix: bundleRoot,
    sheltie: { path: join(bundleRoot, "sheltie"), sha256: "b".repeat(64) },
    herdr: {
      path: join(bundleRoot, "herdr"),
      sha256: "c".repeat(64),
      sourceCommit: REQUIRED_V0_HERDR_SOURCE_COMMIT,
      version: "0.8.0",
      protocol: 20,
    },
    omp: {
      path: join(bundleRoot, "omp"),
      sha256: "d".repeat(64),
      sourceCommit: REQUIRED_V0_OMP_SOURCE_COMMIT,
      version: "0.8.0",
    },
    okfCompaction: { path: join(bundleRoot, "sheltie-okf-compaction.js"), sha256: "e".repeat(64) },
  });
  if (binding.mode !== "bundled") throw new Error("bundled test binding was not parsed as bundled");
  return binding;
}

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
  pingCalls = 0;
  readonly prompts: string[] = [];
  snapshotValue: SessionSnapshot = {
    version: "0.8.0",
    protocol: 20,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
  };

  ping(): Promise<PongResult> {
    this.pingCalls += 1;
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

  tabCreate(): Promise<never> {
    return Promise.reject(new Error("tabCreate was not expected"));
  }

  tabRename(params: { tab_id: string; label: string }): Promise<{ type: "tab_info"; tab: TabInfo }> {
    const tab = this.snapshotValue.tabs.find((candidate) => candidate.tab_id === params.tab_id);
    if (tab === undefined) return Promise.reject(new Error(`tab ${params.tab_id} missing`));
    tab.label = params.label;
    return Promise.resolve({ type: "tab_info", tab });
  }
  agentStart(params: { name: string; kind: string; pane_id: string }): Promise<{
    type: "agent_started";
    agent: AgentInfo;
    argv: string[];
  }> {
    const paneInfo = this.snapshotValue.panes.find((candidate) => candidate.pane_id === params.pane_id);
    if (paneInfo === undefined) return Promise.reject(new Error(`pane ${params.pane_id} missing`));
    const started: AgentInfo = {
      terminal_id: `terminal-${params.name}`,
      agent_instance_id: `instance-${params.name}`,
      name: params.name,
      agent: params.kind,
      agent_status: "idle",
      workspace_id: paneInfo.workspace_id,
      tab_id: paneInfo.tab_id,
      pane_id: paneInfo.pane_id,
      launch_pending: false,
      interactive_ready: true,
    };
    this.snapshotValue.agents.push(started);
    return Promise.resolve({ type: "agent_started", agent: started, argv: [params.kind] });
  }

  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    const found = this.snapshotValue.agents.find((candidate) => candidate.name === target);
    if (found === undefined) return Promise.reject(new Error(`agent ${target} missing`));
    return Promise.resolve({ type: "agent_info", agent: found });
  }

  agentPrompt(params: { target: string; text: string; client_operation_id?: string }): Promise<{
    type: "agent_prompted";
    agent: AgentInfo;
    turn_id: string;
    client_operation_id?: string;
    duplicate: boolean;
  }> {
    const found = this.snapshotValue.agents.find((candidate) => candidate.name === params.target);
    if (found === undefined) return Promise.reject(new Error(`agent ${params.target} missing`));
    this.prompts.push(params.text);
    return Promise.resolve({
      type: "agent_prompted",
      agent: found,
      turn_id: `turn-${params.client_operation_id ?? "ephemeral"}`,
      ...(params.client_operation_id === undefined ? {} : { client_operation_id: params.client_operation_id }),
      duplicate: false,
    });
  }
}

describe("RealRunController", () => {
  test("bootstraps one root node without creating a visible source workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-"));
    roots.push(root);
    const repoRoot = join(root, "repo");
    await initDisposableRepo(repoRoot);
    const databasePath = join(root, "state.sqlite");
    const fake = new FakeRunHerdr();
    const manifest = createManifest(root);
    const store = new SheltieStore(databasePath);
    let reservedTree: TreeRecord | null = null;
    const first = new RealRunController(store, fake, {
      sheltieExecutable: "/opt/sheltie",
      onTreeReserved: (tree) => {
        reservedTree = tree;
        expect(store.getManifest(manifest.digest)?.resolved).toEqual(manifest.manifest);
        expect(tree.runtimeBinding).toEqual({ mode: "external" });
        expect(fake.workspaceCreateCalls).toBe(0);
        expect(fake.pingCalls).toBe(1);
      },
    });

    const tree = await first.startRun({
      runId: "run-real-1",
      repoRoot,
      base: "HEAD",
      worktreeRoot: join(root, "worktrees"),
      manifest,
      herdrSocketPath: join(root, "herdr.sock"),
    });

    expect(fake.workspaceCreateCalls).toBe(0);
    expect(tree).toMatchObject({
      repoSourceWorkspaceId: null,
      rootSpawnPolicy: "workspace",
      manifestDigest: manifest.digest,
      rootRole: "coordinator",
      runtimeBinding: { mode: "external" },
      status: "active",
    });
    expect(reservedTree).toMatchObject({
      treeId: tree.treeId,
      runtimeBinding: { mode: "external" },
    });
    expect(store.findRootNode(tree.treeId)).toMatchObject({
      parentNodeId: null,
      placement: "workspace",
      spawnPolicy: "workspace",
      roleName: "coordinator",
      roleDigest: manifest.manifest.spec.roles.coordinator!.digest,
      taskContract: "create result.txt and finish the node\n",
      baseCommit: tree.baseCommit,
    });
    expect(store.listUnresolvedOperations(tree.treeId)).toEqual([]);
    const running = await first.convergeOnce();
    expect(fake.workspaceCreateCalls).toBe(1);
    expect(running.tree.repoSourceWorkspaceId).toBe("w-source");
    expect(running.nodes[0]).toMatchObject({
      name: "root",
      workspaceId: "w-source",
      tabId: "w-source:t1",
      paneId: "w-source:p1",
      lifecycleStatus: "running",
    });
    expect(fake.prompts[0]).toContain("role coordinator");
    expect(fake.prompts[0]).toContain("--role 'team'");
    expect(fake.prompts[0]).toContain('--caller-pane \"$HERDR_PANE_ID\"');
    expect(fake.prompts[0]).not.toContain("--child-spawn-policy");
    expect(fake.prompts[0]).not.toContain("--placement workspace");
    expect(fake.snapshotValue.workspaces.map((workspace) => workspace.label)).toEqual([running.nodes[0]!.nodeId]);
    expect(fake.snapshotValue.tabs.map((tab) => tab.label)).toEqual(["coord"]);
    store.close();
    writeFileSync(join(root, "sheltie.yaml"), "source manifest changed after start\n");

    const restoredStore = new SheltieStore(databasePath);
    const restored = new RealRunController(restoredStore, fake, { sheltieExecutable: "/opt/sheltie" });
    expect(await restored.resumeBootstrap()).toMatchObject({
      repoSourceWorkspaceId: "w-source",
      rootSpawnPolicy: "workspace",
      manifestDigest: manifest.digest,
      rootRole: "coordinator",
      status: "active",
    });
    expect(restoredStore.listNodes(tree.treeId)).toHaveLength(1);
    expect(restoredStore.getManifest(manifest.digest)?.resolved).toEqual(manifest.manifest);
    restoredStore.close();
  });

  test("leaves a cleaned run and its cleanup receipt unchanged when resumed or converged", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-cleaned-"));
    roots.push(root);
    const store = new SheltieStore(join(root, "state.sqlite"));
    const tree = store.createTree({
      treeId: "tree-cleaned",
      runId: "run-cleaned",
      repoRoot: root,
      repoSourceWorkspaceId: null,
      herdrSocketPath: join(root, "herdr.sock"),
      herdrVersion: "0.8.0",
      herdrProtocol: 20,
      baseCommit: "a".repeat(40),
      worktreeRoot: join(root, "worktrees"),
      rootTaskContract: "already cleaned",
      status: "completed",
    });
    const plan = store.createCleanupPlan({
      planDigest: "c".repeat(64),
      treeId: tree.treeId,
      treeGeneration: tree.generation,
      manifestDigest: tree.manifestDigest,
      plan: { manifestDigest: tree.manifestDigest, actions: [{ kind: "close_workspace" }] },
    });
    store.recordCleanupReceipt({
      planDigest: plan.planDigest,
      actionIndex: 0,
      actionKind: "close_workspace",
      target: "w-cleaned",
      outcome: "removed",
      details: {},
    });
    store.completeCleanupPlan(plan.planDigest);
    const fake = new FakeRunHerdr();
    const controller = new RealRunController(store, fake, { sheltieExecutable: "/opt/sheltie" });
    const before = controller.status();
    const receiptBefore = store.listCleanupReceipts(plan.planDigest);
    const planBefore = store.getCleanupPlan(plan.planDigest);

    expect(await controller.resumeBootstrap()).toEqual(before.tree);
    expect(await controller.convergeOnce()).toEqual(before);
    expect(store.requestCancellation()).toEqual(before.tree);
    expect(controller.status()).toEqual(before);
    expect(store.getCleanupPlan(plan.planDigest)).toEqual(planBefore);
    expect(store.listCleanupReceipts(plan.planDigest)).toEqual(receiptBefore);
    expect(fake.pingCalls).toBe(0);
    store.close();
  });

  test("refuses to switch the root branch while a foreign normal checkout owns the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-foreign-checkout-"));
    roots.push(root);
    const repoRoot = join(root, "repo");
    await initDisposableRepo(repoRoot);
    const initialBranch = await runGit(repoRoot, ["branch", "--show-current"]);
    const fake = new FakeRunHerdr();
    fake.snapshotValue = {
      ...fake.snapshotValue,
      workspaces: [
        {
          workspace_id: "w-foreign",
          label: "root",
          focused: false,
          active_tab_id: "w-foreign:t1",
          worktree: {
            repo_root: repoRoot,
            checkout_path: repoRoot,
            is_linked_worktree: false,
          },
        },
      ],
    };
    const store = new SheltieStore(join(root, "state.sqlite"));
    const controller = new RealRunController(store, fake, { sheltieExecutable: "/opt/sheltie" });

    await expect(
      controller.startRun({
        runId: "run-foreign-checkout",
        repoRoot,
        base: "HEAD",
        worktreeRoot: join(root, "worktrees"),
        manifest: createManifest(root),
        herdrSocketPath: join(root, "herdr.sock"),
      }),
    ).rejects.toThrow("foreign or ambiguous Herdr workspace");

    expect(await runGit(repoRoot, ["branch", "--show-current"])).toBe(initialBranch);
    store.close();
  });

  test("rejects an existing root branch that does not point to the requested base", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-root-base-"));
    roots.push(root);
    const repoRoot = join(root, "repo");
    await initDisposableRepo(repoRoot);
    const initialBranch = await runGit(repoRoot, ["branch", "--show-current"]);
    const initialCommit = await resolveCommit(repoRoot, "HEAD");
    const runId = "run-root-base";
    const branch = branchForNode(null, `run-${requestHash(runId).slice(0, 12)}-root`);
    await runGit(repoRoot, ["branch", branch, initialCommit]);
    writeFileSync(join(repoRoot, "base-advanced.txt"), "new base\n");
    await commitAll(repoRoot, "advance base");
    const store = new SheltieStore(join(root, "state.sqlite"));
    const controller = new RealRunController(store, new FakeRunHerdr(), {
      sheltieExecutable: "/opt/sheltie",
    });

    await expect(
      controller.startRun({
        runId,
        repoRoot,
        base: "HEAD",
        worktreeRoot: join(root, "worktrees"),
        manifest: createManifest(root),
        herdrSocketPath: join(root, "herdr.sock"),
      }),
    ).rejects.toThrow(`root branch ${branch} points to`);

    expect(await runGit(repoRoot, ["branch", "--show-current"])).toBe(initialBranch);
    store.close();
  });

  test("keeps an already-checked-out root branch during bootstrap recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-root-recovery-"));
    roots.push(root);
    const repoRoot = join(root, "repo");
    await initDisposableRepo(repoRoot);
    const baseCommit = await resolveCommit(repoRoot, "HEAD");
    const runId = "run-root-recovery";
    const treeId = `tree-${requestHash(runId).slice(0, 24)}`;
    const branch = branchForNode(null, `run-${requestHash(runId).slice(0, 12)}-root`);
    await runGit(repoRoot, ["switch", "-c", branch, baseCommit]);
    writeFileSync(join(repoRoot, "root-progress.txt"), "preserve response-loss recovery\n");
    await commitAll(repoRoot, "root progress");
    const manifest = createManifest(root);
    const store = new SheltieStore(join(root, "state.sqlite"));
    store.saveManifest({
      manifestDigest: manifest.digest,
      apiVersion: manifest.manifest.apiVersion,
      resolved: manifest.manifest,
    });
    store.createTree({
      treeId,
      runId,
      repoRoot,
      repoSourceWorkspaceId: null,
      herdrSocketPath: join(root, "herdr.sock"),
      herdrVersion: "0.8.0",
      herdrProtocol: 20,
      baseCommit,
      worktreeRoot: join(root, "worktrees"),
      rootTaskContract: "create result.txt and finish the node",
      manifestDigest: manifest.digest,
      rootRole: "coordinator",
      status: "initializing",
    });
    const controller = new RealRunController(store, new FakeRunHerdr(), {
      sheltieExecutable: "/opt/sheltie",
    });

    const resumed = await controller.resumeBootstrap();

    expect(resumed.status).toBe("active");
    expect(store.findRootNode(treeId)).toMatchObject({ branch, baseCommit });
    expect(await runGit(repoRoot, ["branch", "--show-current"])).toBe(branch);
    store.close();
  });

  test("marks the tree completed only after its root node is explicitly finished", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-complete-"));
    roots.push(root);
    const store = new SheltieStore(join(root, "state.sqlite"));
    const manifest = createManifest(root);
    store.saveManifest({
      manifestDigest: manifest.digest,
      apiVersion: manifest.manifest.apiVersion,
      resolved: manifest.manifest,
    });
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
      manifestDigest: manifest.digest,
      rootRole: "coordinator",
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
      roleName: "coordinator",
      roleDigest: manifest.manifest.spec.roles.coordinator!.digest,
      parameters: {},
      resolvedCapabilities: manifest.manifest.spec.roles.coordinator!.capabilities,
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

  test("retains a bundled reservation when its awaited runtime callback fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-bundled-callback-"));
    roots.push(root);
    const repoRoot = join(root, "repo");
    await initDisposableRepo(repoRoot);
    const store = new SheltieStore(join(root, "state.sqlite"));
    const fake = new FakeRunHerdr();
    const manifest = createManifest(root);
    const binding = bundledBinding(root);
    let callbackCalls = 0;
    const controller = new RealRunController(store, fake, {
      sheltieExecutable: binding.sheltie.path,
      onTreeReserved: async (tree) => {
        callbackCalls += 1;
        expect(tree.status).toBe("initializing");
        throw new Error("bundled runtime startup failed");
      },
    });

    await expect(
      controller.startRun({
        runId: "run-bundled-callback",
        repoRoot,
        base: "HEAD",
        worktreeRoot: join(root, "worktrees"),
        manifest,
        herdrSocketPath: binding.socketPath,
        runtimeBinding: binding,
        expectedRuntimeIdentity: { version: binding.herdr.version, protocol: binding.herdr.protocol },
      }),
    ).rejects.toThrow("bundled runtime startup failed");

    const reserved = store.getOnlyTree();
    expect(callbackCalls).toBe(1);
    expect(fake.pingCalls).toBe(0);
    expect(reserved).toMatchObject({
      runtimeBinding: binding,
      status: "initializing",
      herdrVersion: binding.herdr.version,
      herdrProtocol: binding.herdr.protocol,
    });
    expect(store.findRootNode(reserved.treeId)).toBeNull();

    const resumed = new RealRunController(store, fake, { sheltieExecutable: binding.sheltie.path });
    expect(await resumed.resumeBootstrap()).toMatchObject({ treeId: reserved.treeId, status: "active" });
    expect(fake.pingCalls).toBe(1);
    store.close();
  });

  test("lets only one concurrent bundled reservation reach runtime startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-real-run-bundled-concurrent-"));
    roots.push(root);
    const repoRoot = join(root, "repo");
    await initDisposableRepo(repoRoot);
    const store = new SheltieStore(join(root, "state.sqlite"));
    const fake = new FakeRunHerdr();
    const manifest = createManifest(root);
    const binding = bundledBinding(root);
    const runtimeStarted = Promise.withResolvers<void>();
    const releaseRuntime = Promise.withResolvers<void>();
    const starterIds: string[] = [];
    let ensureCalls = 0;
    let stopCalls = 0;
    const runtime = {
      ensureRunning: async (starterId: string) => {
        starterIds.push(starterId);
        ensureCalls += 1;
        runtimeStarted.resolve();
        await releaseRuntime.promise;
      },
      stop: async () => {
        stopCalls += 1;
      },
    };
    const startInput = {
      runId: "run-bundled-concurrent",
      repoRoot,
      base: "HEAD",
      worktreeRoot: join(root, "worktrees"),
      manifest,
      herdrSocketPath: binding.socketPath,
      runtimeBinding: binding,
      expectedRuntimeIdentity: { version: binding.herdr.version, protocol: binding.herdr.protocol },
    };
    const firstController = new RealRunController(store, fake, {
      sheltieExecutable: binding.sheltie.path,
      onTreeReserved: () => runtime.ensureRunning("first"),
    });
    const secondController = new RealRunController(store, fake, {
      sheltieExecutable: binding.sheltie.path,
      onTreeReserved: () => runtime.ensureRunning("second"),
    });

    const first = firstController.startRun(startInput);
    const second = secondController.startRun(startInput);
    await runtimeStarted.promise;
    releaseRuntime.resolve();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(ensureCalls).toBe(1);
    expect(starterIds).toHaveLength(1);
    expect(stopCalls).toBe(0);
    expect(store.getOnlyTree()).toMatchObject({ status: "active", runtimeBinding: binding });
    store.close();
  });
  });
