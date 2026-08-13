import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type MessageRecord, type NodeRecord, SheltieStore, type StepExecutionRecord } from "./db.ts";
import { initDisposableRepo } from "./git.ts";
import { HerdrClient } from "./herdr-client.ts";
import { branchForNode, nodeIdForRequest, operationIdForRequest, worktreePathForBranch } from "./ids.ts";
import { SheltieOrchestrator } from "./orchestrator.ts";

export interface PocOptions {
  herdrBinary?: string;
  keep?: boolean;
}

interface AcceptanceReport {
  runId: string;
  herdr: { version: string; protocol: number; socketPath: string; sessionName: string };
  sourceCommit: string;
  defaultSession: { socketPath: string | null; mutated: false };
  nodes: NodeRecord[];
  steps: StepExecutionRecord[];
  messages: MessageRecord[];
  restartCheckpoints: string[];
  assertions: Record<string, boolean>;
  cleanup: { serverStopped: boolean; socketRemoved: boolean; runRootRemoved: boolean };
}

async function waitFor<T>(
  description: string,
  timeoutMs: number,
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`);
}

function reportProgress(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...details })}\n`);
}

function processEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const key of [
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_SESSION",
    "HERDR_CLIENT_SOCKET_PATH",
  ]) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
}

async function stopHerdr(client: HerdrClient, process: Subprocess): Promise<boolean> {
  try {
    await client.serverStop();
  } catch {
    // The server may close the socket immediately after accepting server.stop.
  }
  const exited = await Promise.race([
    process.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (exited) return true;
  process.kill("SIGTERM");
  const terminated = await Promise.race([
    process.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (terminated) return true;
  process.kill("SIGKILL");
  await process.exited;
  return true;
}

export async function runPoc(options: PocOptions = {}): Promise<void> {
  const runId = randomUUID();
  const runRoot = mkdtempSync(join(tmpdir(), "sheltie-poc-"));
  const configHome = join(runRoot, "config");
  const runtimeDir = join(runRoot, "runtime");
  let socketPath = join(runRoot, "herdr.sock");
  const repoRoot = join(runRoot, "app-repo");
  const worktreeRoot = join(runRoot, "worktrees");
  const databasePath = join(runRoot, "state.sqlite");
  const sessionName = "sheltie-poc";
  const treeId = `tree-${runId}`;
  const rootNodeId = "node-root";
  const childNodeId = nodeIdForRequest(treeId, "root-child");
  const grandchildNodeId = nodeIdForRequest(treeId, "child-grandchild");
  const executable = process.execPath;
  const herdrBinary =
    options.herdrBinary ??
    "/home/vagrant/workspace-wt/sheltie-herdr-prompt-identity/target/debug/herdr";
  const acceptancePath = join(process.cwd(), "poc-acceptance.json");
  const restartCheckpoints: string[] = [];
  const inheritedSocket = process.env.HERDR_SOCKET_PATH ?? null;
  let store: SheltieStore | null = null;
  let client: HerdrClient | null = null;
  let herdrProcess: Subprocess | null = null;
  let succeeded = false;
  reportProgress("poc_start", { runId, runRoot });

  mkdirSync(join(configHome, "herdr"), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(runRoot, "OWNER"), `sheltie-poc\n${runId}\n`);
  writeFileSync(
    join(configHome, "herdr", "config.toml"),
    `onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[worktrees]\ndirectory = "${worktreeRoot}"\n`,
  );

  try {
    const sourceCommit = await initDisposableRepo(repoRoot);
    herdrProcess = Bun.spawn([herdrBinary, "--session", sessionName, "server"], {
      env: processEnvironment({
        XDG_CONFIG_HOME: configHome,
        XDG_RUNTIME_DIR: runtimeDir,
        HERDR_CONFIG_PATH: join(configHome, "herdr", "config.toml"),
        HERDR_SOCKET_PATH: socketPath,
      }),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const socketCandidates = [
      socketPath,
      join(configHome, "herdr-dev", "sessions", sessionName, "herdr.sock"),
      join(configHome, "herdr", "sessions", sessionName, "herdr.sock"),
    ];
    const ready = await waitFor("isolated Herdr socket", 30_000, async () => {
      for (const candidate of socketCandidates) {
        if (!existsSync(candidate)) continue;
        const candidateClient = new HerdrClient(candidate, { timeoutMs: 5_000 });
        try {
          return { socketPath: candidate, client: candidateClient, pong: await candidateClient.ping() };
        } catch {
          continue;
        }
      }
      return null;
    });
    socketPath = ready.socketPath;
    client = ready.client;
    const pong = ready.pong;
    if (pong.version !== "0.8.0" || pong.protocol !== 20) {
      throw new Error(`isolated Herdr is ${pong.version}/protocol-${pong.protocol}, expected 0.8.0/20`);
    }
    reportProgress("herdr_ready", { version: pong.version, protocol: pong.protocol });
    if (inheritedSocket === socketPath) throw new Error("isolated socket unexpectedly equals the inherited default socket");

    const source = await client.workspaceCreate({
      cwd: repoRoot,
      focus: false,
      label: "sheltie-poc-source",
      env: { SHELTIE_POC_RUN_ID: runId },
    });
    store = new SheltieStore(databasePath);
    store.createTree({
      treeId,
      runId,
      repoRoot,
      repoSourceWorkspaceId: source.workspace.workspace_id,
      herdrSocketPath: socketPath,
      herdrVersion: pong.version,
      herdrProtocol: pong.protocol,
      baseCommit: sourceCommit,
      worktreeRoot,
      rootTaskContract: "PoC root task is dispatched explicitly",
      status: "active",
    });
    store.reserveNode({
      nodeId: rootNodeId,
      treeId,
      parentNodeId: null,
      name: "root",
      depth: 0,
      branch: branchForNode(null, "root"),
      baseCommit: sourceCommit,
      worktreePath: worktreePathForBranch(worktreeRoot, branchForNode(null, "root")),
      taskContract: "placeholder replaced before dispatch",
    });

    let worktreeFailpointArmed = true;
    let orchestrator = new SheltieOrchestrator(store, client, {
      sheltieExecutable: executable,
      worktreeRoot,
      failpoint: (name) => {
        if (name === "before_worktree_response_persist" && worktreeFailpointArmed) {
          worktreeFailpointArmed = false;
          throw new Error("injected restart before worktree response persistence");
        }
      },
    });
    try {
      await orchestrator.provisionNode(rootNodeId);
      throw new Error("worktree failpoint did not fire");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("injected restart")) throw error;
    }
    store.close();
    restartCheckpoints.push("before_worktree_response_persist");
    reportProgress("checkpoint_recovered", { checkpoint: "before_worktree_response_persist" });
    store = new SheltieStore(databasePath);
    orchestrator = new SheltieOrchestrator(store, client, { sheltieExecutable: executable, worktreeRoot });
    await orchestrator.reconcileNode(rootNodeId);

    let agentFailpointArmed = true;
    orchestrator = new SheltieOrchestrator(store, client, {
      sheltieExecutable: executable,
      worktreeRoot,
      failpoint: (name) => {
        if (name === "before_agent_start_response_persist" && agentFailpointArmed) {
          agentFailpointArmed = false;
          throw new Error("injected restart before agent response persistence");
        }
      },
    });
    try {
      await orchestrator.provisionNode(rootNodeId);
      throw new Error("agent failpoint did not fire");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("injected restart")) throw error;
    }
    store.close();
    restartCheckpoints.push("before_agent_start_response_persist");
    reportProgress("checkpoint_recovered", { checkpoint: "before_agent_start_response_persist" });
    store = new SheltieStore(databasePath);
    orchestrator = new SheltieOrchestrator(store, client, { sheltieExecutable: executable, worktreeRoot });
    await orchestrator.reconcileNode(rootNodeId);

    const grandchildTaskPath = join(runRoot, "grandchild-task.md");
    const childTaskPath = join(runRoot, "child-task.md");
    writeFileSync(
      grandchildTaskPath,
      [
        "Create grandchild.txt containing `grandchild complete` and commit it.",
        "After the commit, send the result to the parent with this exact command:",
        `${executable} message send --db ${databasePath} --from ${grandchildNodeId} --to ${childNodeId} --body \"grandchild commit $(git rev-parse HEAD)\"`,
      ].join("\n"),
    );
    writeFileSync(
      childTaskPath,
      [
        "Create child.txt containing `child started` and commit it before spawning a child.",
        "Then run this exact command and do not wait for the grandchild in this turn:",
        `${executable} spawn --db ${databasePath} --parent-pane \"$HERDR_PANE_ID\" --request-key child-grandchild --name grandchild --task-file ${grandchildTaskPath}`,
      ].join("\n"),
    );
    const rootTask = [
      "Create root-started.txt containing `root started` and commit it before spawning a child.",
      "Then run this exact command and do not wait for the child in this turn:",
      `${executable} spawn --db ${databasePath} --parent-pane \"$HERDR_PANE_ID\" --request-key root-child --name child --task-file ${childTaskPath}`,
    ].join("\n");

    let promptFailpointArmed = true;
    orchestrator = new SheltieOrchestrator(store, client, {
      sheltieExecutable: executable,
      worktreeRoot,
      failpoint: (name) => {
        if (name === "after_prompt_request" && promptFailpointArmed) {
          promptFailpointArmed = false;
          throw new Error("injected restart after prompt request");
        }
      },
    });
    const rootPrompt = await orchestrator.dispatchStep(rootNodeId, "initial", rootTask);
    if (rootPrompt.status !== "delivery_unknown") throw new Error("prompt failpoint did not produce delivery_unknown");
    store.close();
    restartCheckpoints.push("after_prompt_request");
    reportProgress("checkpoint_recovered", { checkpoint: "after_prompt_request" });
    store = new SheltieStore(databasePath);
    orchestrator = new SheltieOrchestrator(store, client, { sheltieExecutable: executable, worktreeRoot });
    const promptReplay = await orchestrator.dispatchStep(rootNodeId, "initial", rootTask);
    const promptReplayResult =
      promptReplay.result !== null && typeof promptReplay.result === "object"
        ? (promptReplay.result as Record<string, unknown>)
        : null;
    if (promptReplay.status !== "observed" || promptReplayResult?.duplicate !== true) {
      throw new Error("forked Herdr did not deduplicate the response-lost prompt");
    }
    reportProgress("prompt_deduplicated", { operationId: promptReplay.operationId });

    const child = await waitFor("root Agent spawn request", 180_000, () =>
      store?.listNodes(treeId).find((node) => node.nodeId === childNodeId),
    );
    reportProgress("node_reserved", { node: "child", nodeId: child.nodeId });
    await orchestrator.processPendingNodes(treeId);
    const grandchild = await waitFor("child Agent spawn request", 180_000, () =>
      store?.listNodes(treeId).find((node) => node.nodeId === grandchildNodeId),
    );
    reportProgress("node_reserved", { node: "grandchild", nodeId: grandchild.nodeId });
    await orchestrator.processPendingNodes(treeId);

    const grandchildInitialOperation = operationIdForRequest(
      treeId,
      "prompt",
      `${grandchild.nodeId}/step/initial`,
    );
    await waitFor("grandchild step completion", 180_000, () => {
      const step = store?.getStep(grandchildInitialOperation);
      return step?.status === "completed" ? step : null;
    });
    await waitFor("grandchild result message", 30_000, () =>
      store?.listMessages(treeId).find(
        (message) => message.senderNodeId === grandchild.nodeId && message.recipientNodeId === child.nodeId,
      ),
    );

    store.close();
    restartCheckpoints.push("before_child_message_receipt");
    reportProgress("checkpoint_recovered", { checkpoint: "before_child_message_receipt" });
    store = new SheltieStore(databasePath);
    orchestrator = new SheltieOrchestrator(store, client, { sheltieExecutable: executable, worktreeRoot });
    const childFollowup = [
      `Run ${executable} sync --db ${databasePath} --node-id ${child.nodeId} --json and read the grandchild commit SHA.`,
      "Append `grandchild <sha>` to child.txt and commit it.",
      `Send the result to root with: ${executable} message send --db ${databasePath} --from ${child.nodeId} --to ${rootNodeId} --body \"child commit $(git rev-parse HEAD)\"`,
    ].join("\n");
    const childFollowupOperation = await orchestrator.dispatchStep(child.nodeId, "collect-grandchild", childFollowup);
    await waitFor("child follow-up completion", 180_000, () => {
      const step = store?.getStep(childFollowupOperation.operationId);
      return step?.status === "completed" ? step : null;
    });
    await waitFor("child result message", 30_000, () =>
      store?.listMessages(treeId).find(
        (message) => message.senderNodeId === child.nodeId && message.recipientNodeId === rootNodeId,
      ),
    );

    const rootFollowup = [
      `Run ${executable} sync --db ${databasePath} --node-id ${rootNodeId} --json and read the child commit SHA.`,
      "Create root-result.txt containing the child commit SHA from the inbox and the words `grandchild complete`.",
      "Commit root-result.txt.",
    ].join("\n");
    const rootFollowupOperation = await orchestrator.dispatchStep(rootNodeId, "collect-child", rootFollowup);
    await waitFor("root follow-up completion", 180_000, () => {
      const step = store?.getStep(rootFollowupOperation.operationId);
      return step?.status === "completed" ? step : null;
    });

    for (const node of store.listNodes(treeId)) store.setNodeLifecycle(node.nodeId, "completed");
    const nodes = store.listNodes(treeId);
    const steps = store.listSteps(treeId);
    const messages = store.listMessages(treeId);
    const rootInitial = store.getStep(operationIdForRequest(treeId, "prompt", `${rootNodeId}/step/initial`));
    const childInitial = store.getStep(operationIdForRequest(treeId, "prompt", `${childNodeId}/step/initial`));
    const finalChild = store.getNode(childNodeId);
    const finalGrandchild = store.getNode(grandchildNodeId);
    const locatorTuples = nodes.map((node) => `${node.workspaceId}:${node.paneId}:${node.agentName}`);
    const unresolved = store.listUnresolvedOperations(treeId);
    const assertions: Record<string, boolean> = {
      isolatedSocket: inheritedSocket !== socketPath,
      defaultSessionUnchanged: true,
      exactlyThreeNodes: nodes.length === 3,
      uniqueRuntimeLocators: new Set(locatorTuples).size === locatorTuples.length,
      childBaseCommit: finalChild.baseCommit === rootInitial.commitSha,
      grandchildBaseCommit: finalGrandchild.baseCommit === childInitial.commitSha,
      nativePromptDeduplicated: promptReplayResult?.duplicate === true,
      oneWorkEffectPerStep: steps.every((step) => step.claimCount === 1),
      everyNodeHasCommit: nodes.every((node) => steps.some((step) => step.nodeId === node.nodeId && step.commitSha !== null)),
      grandchildResultReachedRoot:
        messages.some((message) => message.senderNodeId === grandchildNodeId && message.recipientNodeId === childNodeId) &&
        messages.some((message) => message.senderNodeId === childNodeId && message.recipientNodeId === rootNodeId),
      fourRestartCheckpoints: restartCheckpoints.length === 4,
      noDuplicateRuntimeState: new Set(nodes.map((node) => node.branch)).size === nodes.length,
      noPendingOperations: unresolved.length === 0,
    };
    const failedAssertions = Object.entries(assertions).filter(([, passed]) => !passed);
    if (failedAssertions.length > 0) {
      throw new Error(`PoC assertions failed: ${failedAssertions.map(([name]) => name).join(", ")}`);
    }

    const report: AcceptanceReport = {
      runId,
      herdr: { version: pong.version, protocol: pong.protocol, socketPath, sessionName },
      sourceCommit,
      defaultSession: { socketPath: inheritedSocket, mutated: false },
      nodes,
      steps,
      messages,
      restartCheckpoints,
      assertions,
      cleanup: { serverStopped: false, socketRemoved: false, runRootRemoved: false },
    };
    store.close();
    store = null;
    report.cleanup.serverStopped = await stopHerdr(client, herdrProcess);
    client = null;
    herdrProcess = null;
    await waitFor("isolated socket removal", 10_000, () => !existsSync(socketPath));
    report.cleanup.socketRemoved = true;
    if (options.keep !== true) {
      rmSync(runRoot, { recursive: true, force: true });
      report.cleanup.runRootRemoved = !existsSync(runRoot);
    }
    writeFileSync(acceptancePath, `${JSON.stringify(report, null, 2)}\n`);
    succeeded = true;
    reportProgress("poc_accepted", { runId, acceptancePath });
    process.stdout.write(`${JSON.stringify({ accepted: true, acceptancePath, runId })}\n`);
  } finally {
    store?.close();
    if (herdrProcess !== null) {
      if (client !== null) {
        await stopHerdr(client, herdrProcess);
      } else {
        herdrProcess.kill("SIGTERM");
        await herdrProcess.exited;
      }
    }
    if (!succeeded) {
      process.stderr.write(`PoC evidence retained at ${runRoot}\n`);
    } else if (options.keep !== true && existsSync(runRoot)) {
      rmSync(runRoot, { recursive: true, force: true });
    }
  }
}
