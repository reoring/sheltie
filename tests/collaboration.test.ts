import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { SheltieStore } from "../src/db.ts";
import { commitAll, initDisposableRepo, resolveCommit } from "../src/git.ts";
import type {
  AgentInfo,
  PaneInfo,
  PongResult,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
  WorktreeInfo,
} from "../src/herdr-client.ts";
import { agentNameForNode } from "../src/ids.ts";
import { MergeController } from "../src/merge.ts";
import { type HerdrControl, SheltieOrchestrator } from "../src/orchestrator.ts";
import { runCli } from "../src/cli.ts";
import { resolveManifestFile } from "../src/manifest.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class CollaborationHerdr implements HerdrControl {
  readonly tabCreates: Record<string, unknown>[] = [];
  readonly worktreeCreates: Record<string, unknown>[] = [];
  snapshotValue: SessionSnapshot;

  constructor(repoRoot: string) {
    this.snapshotValue = {
      version: "0.8.0",
      protocol: 20,
      workspaces: [
        {
          workspace_id: "w-root",
          label: "root-space",
          focused: false,
          active_tab_id: "w-root:t1",
          worktree: { repo_root: repoRoot, checkout_path: repoRoot, is_linked_worktree: true },
        },
      ],
      tabs: [{ tab_id: "w-root:t1", workspace_id: "w-root", label: "root" }],
      panes: [this.pane("w-root:t1", "w-root:p1")],
      agents: [],
    };
  }

  ping(): Promise<PongResult> {
    return Promise.resolve({ type: "pong", version: "0.8.0", protocol: 20, capabilities: null });
  }

  snapshot(): Promise<SessionSnapshot> {
    return Promise.resolve(structuredClone(this.snapshotValue));
  }

  workspaceCreate(): Promise<never> {
    return Promise.reject(new Error("workspaceCreate was not expected"));
  }

  worktreeList(): Promise<{
    type: "worktree_list";
    source: { repo_root: string; source_workspace_id?: string };
    worktrees: WorktreeInfo[];
  }> {
    const root = this.snapshotValue.workspaces[0]?.worktree;
    return Promise.resolve({
      type: "worktree_list",
      source: { repo_root: root?.repo_root ?? "", source_workspace_id: "w-source" },
      worktrees: [],
    });
  }

  worktreeCreate(params: {
    workspace_id: string;
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
  }> {
    this.worktreeCreates.push(params);
    return Promise.reject(new Error("tab collaboration must not create a worktree"));
  }

  tabCreate(params: {
    workspace_id: string;
    cwd?: string;
    focus?: boolean;
    label?: string;
    env?: Record<string, string>;
  }): Promise<{ type: "tab_created"; tab: TabInfo; root_pane: PaneInfo }> {
    this.tabCreates.push(params);
    const number = this.snapshotValue.tabs.length + 1;
    const tab: TabInfo = {
      tab_id: `${params.workspace_id}:t${number}`,
      workspace_id: params.workspace_id,
      label: params.label ?? `tab-${number}`,
    };
    const rootPane = this.pane(tab.tab_id, `${params.workspace_id}:p${number}`);
    this.snapshotValue.tabs.push(tab);
    this.snapshotValue.panes.push(rootPane);
    return Promise.resolve({ type: "tab_created", tab, root_pane: rootPane });
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
    const pane = this.snapshotValue.panes.find((candidate) => candidate.pane_id === params.pane_id);
    if (pane === undefined) return Promise.reject(new Error(`pane ${params.pane_id} missing`));
    const started = this.agent(params.name, pane);
    this.snapshotValue.agents.push(started);
    return Promise.resolve({ type: "agent_started", agent: started, argv: [params.kind] });
  }

  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    const found = this.snapshotValue.agents.find(
      (candidate) => candidate.name === target || candidate.pane_id === target,
    );
    if (found === undefined) return Promise.reject(new Error(`agent ${target} missing`));
    return Promise.resolve({ type: "agent_info", agent: found });
  }

  agentPrompt(params: {
    target: string;
    text: string;
    client_operation_id?: string;
  }): Promise<{
    type: "agent_prompted";
    agent: AgentInfo;
    turn_id: string;
    client_operation_id?: string;
    duplicate: boolean;
  }> {
    const found = this.snapshotValue.agents.find((candidate) => candidate.name === params.target);
    if (found === undefined) return Promise.reject(new Error(`agent ${params.target} missing`));
    return Promise.resolve({
      type: "agent_prompted",
      agent: found,
      turn_id: `turn-${params.client_operation_id ?? "ephemeral"}`,
      ...(params.client_operation_id === undefined ? {} : { client_operation_id: params.client_operation_id }),
      duplicate: false,
    });
  }

  private pane(tabId: string, paneId: string): PaneInfo {
    const cwd = this.snapshotValue?.workspaces[0]?.worktree?.checkout_path;
    return {
      pane_id: paneId,
      workspace_id: "w-root",
      tab_id: tabId,
      ...(cwd === undefined ? {} : { cwd }),
      agent_status: "idle",
    };
  }

  private agent(name: string, pane: PaneInfo): AgentInfo {
    return {
      terminal_id: `terminal-${pane.pane_id}`,
      agent_instance_id: `instance-${pane.pane_id}`,
      name,
      agent: "omp",
      agent_status: "idle",
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      pane_id: pane.pane_id,
      launch_pending: false,
      interactive_ready: true,
      agent_session: { source: "test", agent: "omp", kind: "id", value: `session-${pane.pane_id}` },
    };
  }
}

function createCollaborationManifest(root: string) {
  const path = join(root, "sheltie.yaml");
  writeFileSync(path, `apiVersion: sheltie.dev/v1alpha1
kind: Run
metadata:
  name: collaboration-test
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
          coordinate tab workers
      capabilities:
        spawn:
          roles: [researcher, reviewer]
        mergeChildren: true
        messaging:
          sendTo: [children]
          receiveFrom: [children]
    researcher:
      placement: tab
      agent:
        kind: omp
      prompt:
        inline: |
          research only; send findings to parent inbox
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent]
      executionPolicy:
        workspace: read-only
    reviewer:
      placement: tab
      agent:
        kind: omp
      prompt:
        inline: |
          review only
      capabilities:
        spawn:
          roles: [reviewer]
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent, children]
      executionPolicy:
        workspace: read-only
`);
  return resolveManifestFile(path);
}

async function createFixture(): Promise<{
  store: SheltieStore;
  repoRoot: string;
  herdr: CollaborationHerdr;
  orchestrator: SheltieOrchestrator;
}> {
  const root = mkdtempSync(join(tmpdir(), "sheltie-collaboration-"));
  roots.push(root);
  const repoRoot = join(root, "repo");
  const baseCommit = await initDisposableRepo(repoRoot);
  const manifest = createCollaborationManifest(root);
  const store = new SheltieStore(join(root, "state.sqlite"));
  store.saveManifest({
    manifestDigest: manifest.digest,
    apiVersion: manifest.manifest.apiVersion,
    resolved: manifest.manifest,
  });
  store.createTree({
    treeId: "tree-collaboration",
    runId: "run-collaboration",
    repoRoot,
    repoSourceWorkspaceId: "w-source",
    herdrSocketPath: join(root, "herdr.sock"),
    herdrVersion: "0.8.0",
    herdrProtocol: 20,
    baseCommit,
    worktreeRoot: join(root, "worktrees"),
    rootTaskContract: "coordinate tab workers",
    manifestDigest: manifest.digest,
    rootRole: "coordinator",
    status: "active",
  });
  store.reserveNode({
    nodeId: "node-root",
    treeId: "tree-collaboration",
    parentNodeId: null,
    name: "root",
    depth: 0,
    placement: "workspace",
    branch: "main",
    baseCommit,
    worktreePath: repoRoot,
    taskContract: "coordinate tab workers",
    roleName: "coordinator",
    roleDigest: manifest.manifest.spec.roles.coordinator!.digest,
    parameters: {},
    resolvedCapabilities: manifest.manifest.spec.roles.coordinator!.capabilities,
  });
  store.bindWorktree("node-root", { workspaceId: "w-root", tabId: "w-root:t1", paneId: "w-root:p1" });
  store.bindAgent("node-root", {
    agentName: agentNameForNode("node-root"),
    terminalId: "terminal-root",
    agentInstanceId: "instance-root",
  });
  store.setNodeLifecycle("node-root", "running");
  const herdr = new CollaborationHerdr(repoRoot);
  const orchestrator = new SheltieOrchestrator(store, herdr, {
    sheltieExecutable: "/workspace/sheltie/dist/sheltie",
    worktreeRoot: join(root, "worktrees"),
    agentReadyTimeoutMs: 100,
  });
  return { store, repoRoot, herdr, orchestrator };
}

function completeStep(store: SheltieStore, nodeId: string, paneId: string, commitSha: string): void {
  const operationId = `step-${nodeId}`;
  store.reserveOperation({
    operationId,
    treeId: "tree-collaboration",
    nodeId,
    kind: "prompt",
    requestKey: `${nodeId}/step/test`,
    requestHash: `hash-${nodeId}`,
    request: {},
  });
  store.setOperationStatus(operationId, "observed");
  store.reserveStep({
    operationId,
    nodeId,
    runNumber: 1,
    iterationNumber: 1,
    stepNumber: 1,
    promptSha256: "a".repeat(64),
  });
  store.claimStep(operationId, paneId);
  store.completeStep({ operationId, agentSession: paneId, commitSha, resultMessageId: null });
  store.setOperationStatus(operationId, "completed", { result: { commitSha } });
}

async function serveAgent(socketPath: string, current: AgentInfo): Promise<Server> {
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as { id: string };
      socket.end(`${JSON.stringify({ id: request.id, result: { type: "agent_info", agent: current } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("space and tab collaboration", () => {
  test("provisions a tab node in its parent space and exchanges a durable inbox result", async () => {
    const { store, repoRoot, herdr, orchestrator } = await createFixture();
    const child = await orchestrator.reserveChild({
      parentPaneId: "w-root:p1",
      requestKey: "researcher",
      name: "researcher",
      roleName: "researcher",
    });

    const provisioned = await orchestrator.provisionNode(child.nodeId);

    expect(provisioned).toMatchObject({
      placement: "tab",
      parentNodeId: "node-root",
      workspaceId: "w-root",
      branch: "main",
      worktreePath: repoRoot,
    });
    await expect(
      orchestrator.reserveChild({
        parentPaneId: provisioned.paneId as string,
        requestKey: "unauthorized-grandchild",
        name: "unauthorized",
        roleName: "reviewer",
      }),
    ).rejects.toThrow("role researcher cannot spawn role reviewer");
    expect(herdr.worktreeCreates).toEqual([]);
    expect(herdr.tabCreates).toEqual([
      expect.objectContaining({
        workspace_id: "w-root",
        cwd: repoRoot,
        label: `researcher-${child.nodeId.slice(-8)}`,
      }),
    ]);
    store.sendMessage({
      messageId: "message-research",
      treeId: "tree-collaboration",
      senderNodeId: child.nodeId,
      recipientNodeId: "node-root",
      channel: "inbox",
      kind: "progress",
      priority: 5,
      replyToMessageId: null,
      body: "research update",
    });
    expect(store.syncInbox("node-root").map((message) => message.body)).toEqual(["research update"]);

    const head = await resolveCommit(repoRoot, "HEAD");
    await expect(
      new MergeController(store).mergeChild({
        parentPaneId: "w-root:p1",
        childNodeId: child.nodeId,
      }),
    ).rejects.toThrow("must not be merged");
    completeStep(store, child.nodeId, provisioned.paneId as string, head);
    expect(store.finishNode(child.nodeId, provisioned.paneId as string).lifecycleStatus).toBe("completed");
    store.sendMessage({
      messageId: "message-research-result",
      treeId: "tree-collaboration",
      senderNodeId: child.nodeId,
      recipientNodeId: "node-root",
      channel: "inbox",
      kind: "result",
      priority: 5,
      replyToMessageId: null,
      body: "research complete",
    });
    expect(store.syncInbox("node-root").map((message) => message.body)).toEqual(["research complete"]);
    completeStep(store, "node-root", "w-root:p1", head);
    expect(store.finishNode("node-root", "w-root:p1").lifecycleStatus).toBe("completed");
    store.close();
  });

  test("allows a read-only tab to complete while its parent shared worktree has committed and untracked work", async () => {
    const { store, repoRoot, orchestrator } = await createFixture();
    const child = await orchestrator.reserveChild({
      parentPaneId: "w-root:p1",
      requestKey: "read-only-step",
      name: "researcher",
      roleName: "researcher",
    });
    const provisioned = await orchestrator.provisionNode(child.nodeId);
    writeFileSync(join(repoRoot, "parent-committed.txt"), "parent committed work\n");
    const parentCommit = await commitAll(repoRoot, "parent work");
    writeFileSync(join(repoRoot, "parent-untracked.txt"), "parent untracked work\n");

    const operationId = "step-read-only";
    store.reserveOperation({
      operationId,
      treeId: child.treeId,
      nodeId: child.nodeId,
      kind: "prompt",
      requestKey: `${child.nodeId}/step/read-only`,
      requestHash: "read-only-step",
      request: {},
    });
    store.setOperationStatus(operationId, "observed");
    store.reserveStep({
      operationId,
      nodeId: child.nodeId,
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256: "a".repeat(64),
    });
    expect(store.claimStep(operationId, provisioned.paneId as string)).toEqual({ outcome: "claimed" });

    const server = await serveAgent(store.getTree(child.treeId).herdrSocketPath, {
      terminal_id: provisioned.terminalId!,
      agent_instance_id: provisioned.agentInstanceId!,
      name: provisioned.agentName!,
      agent: "omp",
      agent_status: "working",
      workspace_id: provisioned.workspaceId!,
      tab_id: provisioned.tabId!,
      pane_id: provisioned.paneId!,
      launch_pending: false,
      interactive_ready: true,
    });
    try {
      await runCli([
        "step",
        "complete",
        "--db",
        store.path,
        "--caller-pane",
        provisioned.paneId as string,
        "--operation-id",
        operationId,
        "--commit",
        parentCommit,
      ]);
      expect(store.getStep(operationId)).toMatchObject({ status: "completed", commitSha: parentCommit });
    } finally {
      await closeServer(server);
      store.close();
    }
  });

  test("reconciles a response-lost tab by exact parent space and label", async () => {
    const { store, herdr, orchestrator } = await createFixture();
    const child = await orchestrator.reserveChild({
      parentPaneId: "w-root:p1",
      requestKey: "reviewer",
      name: "reviewer",
      roleName: "reviewer",
    });
    let failOnce = true;
    const failing = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: "/workspace/sheltie/dist/sheltie",
      failpoint: (name) => {
        if (name === "before_tab_response_persist" && failOnce) {
          failOnce = false;
          throw new Error("tab response lost");
        }
      },
    });

    await expect(failing.provisionNode(child.nodeId)).rejects.toThrow("tab response lost");
    const reconciled = await orchestrator.reconcileNode(child.nodeId);

    expect(reconciled).toMatchObject({ placement: "tab", workspaceId: "w-root", tabId: "w-root:t2" });
    expect(herdr.tabCreates).toHaveLength(1);
    expect(store.listUnresolvedOperations("tree-collaboration")).toEqual([]);
    store.close();
  });

  test("rejects a different request key that reuses an existing sibling name", async () => {
    const { store, orchestrator } = await createFixture();
    await orchestrator.reserveChild({
      parentPaneId: "w-root:p1",
      requestKey: "reviewer-first",
      name: "reviewer",
      roleName: "reviewer",
    });

    await expect(
      orchestrator.reserveChild({
        parentPaneId: "w-root:p1",
        requestKey: "reviewer-second",
        name: "reviewer",
        roleName: "reviewer",
      }),
    ).rejects.toThrow("already reserved by a different request");

    expect(store.listOperations("tree-collaboration").filter((operation) => operation.kind === "spawn")).toHaveLength(1);
    store.close();
  });

  test("reconciles nested same-name tabs by deterministic workspace-unique labels", async () => {
    const { store, herdr, orchestrator } = await createFixture();
    const parentTab = await orchestrator.reserveChild({
      parentPaneId: "w-root:p1",
      requestKey: "reviewer-parent",
      name: "reviewer",
      roleName: "reviewer",
    });
    const parentProvisioned = await orchestrator.provisionNode(parentTab.nodeId);
    const nestedTab = await orchestrator.reserveChild({
      parentPaneId: parentProvisioned.paneId as string,
      requestKey: "reviewer-nested",
      name: "reviewer",
      roleName: "reviewer",
    });
    let failOnce = true;
    const failing = new SheltieOrchestrator(store, herdr, {
      sheltieExecutable: "/workspace/sheltie/dist/sheltie",
      failpoint: (name) => {
        if (name === "before_tab_response_persist" && failOnce) {
          failOnce = false;
          throw new Error("nested tab response lost");
        }
      },
    });

    await expect(failing.provisionNode(nestedTab.nodeId)).rejects.toThrow("nested tab response lost");
    const reconciled = await orchestrator.reconcileNode(nestedTab.nodeId);

    expect(reconciled).toMatchObject({ placement: "tab", workspaceId: "w-root", tabId: "w-root:t3" });
    expect(herdr.tabCreates.map((request) => request.label)).toEqual([
      `reviewer-${parentTab.nodeId.slice(-8)}`,
      `reviewer-${nestedTab.nodeId.slice(-8)}`,
    ]);
    expect(store.listUnresolvedOperations("tree-collaboration")).toEqual([]);
    store.close();
  });
});
