#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AgentCallerAuthenticator,
  assertAuthenticatedAgentCaller,
  type AuthenticatedAgentCaller,
} from "./agent-caller.ts";
import { CleanupController, type CleanupPlan } from "./cleanup.ts";
import { CancellationController } from "./cancel.ts";
import { commitExistsOnBranch, isCleanWorktree } from "./git.ts";
import { HerdrClient } from "./herdr-client.ts";
import { createId } from "./ids.ts";
import { MergeController } from "./merge.ts";
import { SheltieOrchestrator } from "./orchestrator.ts";
import { QuiesceController } from "./quiesce.ts";
import { SheltieStore, type NodeRecord } from "./db.ts";
import { getManifestRole, parseResolvedManifest, resolveManifestFile } from "./manifest.ts";
import { ObservationReader, projectObservationLifecycle, type ObservationSnapshot } from "./observation.ts";
import { RealRunController } from "./run.ts";
import { assertPrivateStateDirectory, assertPrivateStateParentForDatabase, createPrivateStateDirectory } from "./state-security.ts";

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    if (separator !== -1) {
      flags.set(argument.slice(2, separator), argument.slice(separator + 1));
      continue;
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { positionals, flags };
}

function requiredFlag(arguments_: ParsedArguments, name: string): string {
  const value = arguments_.flags.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function optionalFlag(arguments_: ParsedArguments, name: string): string | undefined {
  const value = arguments_.flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}


function boundedIntegerFlag(
  arguments_: ParsedArguments,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const text = optionalFlag(arguments_, name);
  if (text === undefined) return defaultValue;
  const value = Number.parseInt(text, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}


function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export interface CleanupPlanProjection {
  planDigest: string;
  treeGeneration: number;
  manifestDigest: string | null;
  actionCount: number;
  blockerCount: number;
}

export interface CleanupApplyProjection {
  plan: CleanupPlanProjection;
  receiptCount: number;
  duplicate: boolean;
}

export function projectCleanupPlan(
  plan: Pick<CleanupPlan, "planDigest" | "treeGeneration" | "manifestDigest" | "actions" | "blockers">,
): CleanupPlanProjection {
  return {
    planDigest: plan.planDigest,
    treeGeneration: plan.treeGeneration,
    manifestDigest: plan.manifestDigest,
    actionCount: plan.actions.length,
    blockerCount: plan.blockers.length,
  };
}

export function projectCleanupApplyResult(result: {
  plan: Pick<CleanupPlan, "planDigest" | "treeGeneration" | "manifestDigest" | "actions" | "blockers">;
  receipts: readonly unknown[];
  duplicate: boolean;
}): CleanupApplyProjection {
  return {
    plan: projectCleanupPlan(result.plan),
    receiptCount: result.receipts.length,
    duplicate: result.duplicate,
  };
}

function cleanupPreviewOutput(statePath: string, plan: CleanupPlan, unsafeOutput: boolean): unknown {
  if (unsafeOutput) return { statePath, mode: "preview", plan };
  return { mode: "preview", plan: projectCleanupPlan(plan) };
}

function cleanupApplyOutput(
  statePath: string,
  result: {
    plan: CleanupPlan;
    receipts: readonly unknown[];
    duplicate: boolean;
  },
  unsafeOutput: boolean,
): unknown {
  if (unsafeOutput) return { statePath, mode: "applied", ...result };
  return { mode: "applied", ...projectCleanupApplyResult(result) };
}


function usage(): string {
  return `sheltie commands:
  sheltie manifest validate --file PATH
  sheltie manifest resolve --file PATH --json
  sheltie observe snapshot --state PATH [--unsafe-output]
  sheltie run start --manifest PATH --repo PATH --herdr-socket PATH [--base REF] [--state PATH] [--once] [--unsafe-output]
  sheltie run resume --state PATH [--once] [--unsafe-output]
  sheltie run cancel --state PATH [--grace-ms N] [--unsafe-output]
  sheltie run quiesce --state PATH [--grace-ms N] [--unsafe-output]
  sheltie run status --state PATH [--unsafe-output]
  sheltie run cleanup --state PATH [--apply --plan-digest SHA256] [--unsafe-output]
  sheltie spawn --db PATH [--caller-pane ID] --request-key KEY --name NAME --role ROLE [--params-json JSON]
  sheltie step claim --db PATH --operation-id ID [--caller-pane ID]
  sheltie step complete --db PATH --operation-id ID --commit SHA [--caller-pane ID]
  sheltie node finish --db PATH --node-id ID [--caller-pane ID]
  sheltie sync --db PATH [--caller-pane ID] [--wait-ms N]
  sheltie merge --db PATH [--caller-pane ID] --child-node ID
  sheltie message send --db PATH [--caller-pane ID] --to NODE --body TEXT [--kind progress|result] [--priority N]
  sheltie reconcile --db PATH --tree-id ID --unsafe-output
`;
}

function runManifest(arguments_: ParsedArguments): void {
  const action = arguments_.positionals[1];
  if (action !== "validate" && action !== "resolve") {
    throw new Error("manifest action must be validate or resolve");
  }
  const document = resolveManifestFile(resolve(requiredFlag(arguments_, "file")));
  if (action === "validate") {
    printJson({
      valid: true,
      digest: document.digest,
      name: document.manifest.metadata.name,
      roles: Object.keys(document.manifest.spec.roles),
    });
  } else {
    printJson({
      digest: document.digest,
      manifest: document.manifest,
    });
  }
}

function runObserve(arguments_: ParsedArguments): void {
  if (arguments_.positionals[1] !== "snapshot") {
    throw new Error("observe action must be snapshot");
  }
  printJson(new ObservationReader(resolve(requiredFlag(arguments_, "state"))).snapshot());
}

async function runSpawn(arguments_: ParsedArguments): Promise<void> {
  const requestKey = requiredFlag(arguments_, "request-key");
  const name = requiredFlag(arguments_, "name");
  const roleName = requiredFlag(arguments_, "role");
  const parametersText = optionalFlag(arguments_, "params-json");
  let parameters: unknown = {};
  if (parametersText !== undefined) {
    try {
      parameters = JSON.parse(parametersText) as unknown;
    } catch (error) {
      throw new Error(`--params-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await withAuthenticatedAgentStore(arguments_, async (store, caller) => {
    const orchestrator = new SheltieOrchestrator(store, new HerdrClient(caller.tree.herdrSocketPath), {
      sheltieExecutable: process.execPath,
      worktreeRoot: caller.tree.worktreeRoot,
    });
    printJson(
      await orchestrator.reserveChild({
        parentPaneId: caller.callerPaneId,
        requestKey,
        name,
        roleName,
        parameters,
      }),
    );
  });
}

function requiredCallerPane(arguments_: ParsedArguments): string {
  const callerPaneId = optionalFlag(arguments_, "caller-pane") ?? process.env.HERDR_PANE_ID ?? "";
  if (callerPaneId.length === 0) throw new Error("--caller-pane or HERDR_PANE_ID is required");
  return callerPaneId;
}

async function withAuthenticatedAgentStore<T>(
  arguments_: ParsedArguments,
  operation: (store: SheltieStore, caller: AuthenticatedAgentCaller) => T | Promise<T>,
  expectedNodeId?: string,
): Promise<T> {
  const databasePath = requiredFlag(arguments_, "db");
  const callerPaneId = requiredCallerPane(arguments_);
  const caller = await new AgentCallerAuthenticator().authenticate({
    databasePath,
    callerPaneId,
    ...(expectedNodeId === undefined ? {} : { expectedNodeId }),
  });
  const store = new SheltieStore(databasePath);
  try {
    assertAuthenticatedAgentCaller(store, caller);
    return await operation(store, caller);
  } finally {
    store.close();
  }
}

function assertSameAuthenticatedAgentCaller(
  initial: AuthenticatedAgentCaller,
  refreshed: AuthenticatedAgentCaller,
): void {
  if (
    initial.node.nodeId !== refreshed.node.nodeId ||
    initial.node.treeId !== refreshed.node.treeId ||
    initial.node.paneId !== refreshed.node.paneId ||
    initial.node.agentName !== refreshed.node.agentName ||
    initial.node.terminalId !== refreshed.node.terminalId ||
    initial.node.agentInstanceId !== refreshed.node.agentInstanceId ||
    initial.tree.treeId !== refreshed.tree.treeId ||
    initial.tree.herdrSocketPath !== refreshed.tree.herdrSocketPath ||
    initial.tree.herdrProtocol !== refreshed.tree.herdrProtocol ||
    initial.tree.worktreeRoot !== refreshed.tree.worktreeRoot
  ) {
    throw new Error(`caller identity changed while sync was waiting for node ${initial.node.nodeId}`);
  }
}

function isReadOnlyManifestTab(store: SheltieStore, node: NodeRecord): boolean {
  if (node.placement !== "tab" || node.roleName === null) return false;
  const tree = store.getTree(node.treeId);
  if (tree.manifestDigest === null) return false;
  const record = store.getManifest(tree.manifestDigest);
  if (record === null) throw new Error(`tree ${tree.treeId} manifest ${tree.manifestDigest} is missing`);
  return getManifestRole(parseResolvedManifest(record.resolved), node.roleName).executionPolicy.workspace === "read-only";
}

async function runStep(arguments_: ParsedArguments): Promise<void> {
  const action = arguments_.positionals[1];
  if (action !== "claim" && action !== "complete") throw new Error("step action must be claim or complete");
  const operationId = requiredFlag(arguments_, "operation-id");
  const commitSha = action === "complete" ? requiredFlag(arguments_, "commit") : undefined;
  await withAuthenticatedAgentStore(arguments_, async (store, caller) => {
    const step = store.getStep(operationId);
    if (step.nodeId !== caller.node.nodeId) {
      throw new Error(
        `caller pane ${caller.callerPaneId} is bound to node ${caller.node.nodeId}, not step owner ${step.nodeId}`,
      );
    }
    if (action === "claim") {
      printJson(store.claimStep(operationId, caller.callerPaneId));
      return;
    }
    if (commitSha === undefined) throw new Error("--commit is required");
    const node = store.getNode(step.nodeId);
    if (!(await commitExistsOnBranch(node.worktreePath, commitSha, "HEAD"))) {
      throw new Error(`commit ${commitSha} is not reachable from node ${node.nodeId} HEAD`);
    }
    if (!isReadOnlyManifestTab(store, node) && !(await isCleanWorktree(node.worktreePath))) {
      throw new Error(`node ${node.nodeId} worktree is dirty`);
    }
    store.completeStep({
      operationId,
      agentSession: caller.callerPaneId,
      commitSha,
      resultMessageId: null,
    });
    store.setOperationStatus(operationId, "completed", { result: { commitSha } });
    printJson(store.getStep(operationId));
  });
}

async function runNode(arguments_: ParsedArguments): Promise<void> {
  if (arguments_.positionals[1] !== "finish") throw new Error("node action must be finish");
  const nodeId = requiredFlag(arguments_, "node-id");
  await withAuthenticatedAgentStore(
    arguments_,
    (store, caller) => printJson(store.finishNode(nodeId, caller.callerPaneId)),
    nodeId,
  );
}

async function runSync(arguments_: ParsedArguments): Promise<void> {
  const databasePath = requiredFlag(arguments_, "db");
  const callerPaneId = requiredCallerPane(arguments_);
  const waitMs = boundedIntegerFlag(arguments_, "wait-ms", 0, 0, 180_000);
  const authenticator = new AgentCallerAuthenticator();
  const initialCaller = await authenticator.authenticate({ databasePath, callerPaneId });
  const store = new SheltieStore(databasePath);
  try {
    assertAuthenticatedAgentCaller(store, initialCaller);
    const deadline = Date.now() + waitMs;
    while (true) {
      if (store.hasUnreadInbox(initialCaller.node.nodeId)) {
        assertAuthenticatedAgentCaller(store, initialCaller);
        const refreshedCaller = await authenticator.authenticate({
          databasePath,
          callerPaneId,
          expectedNodeId: initialCaller.node.nodeId,
        });
        assertSameAuthenticatedAgentCaller(initialCaller, refreshedCaller);
        assertAuthenticatedAgentCaller(store, refreshedCaller);
        printJson({ messages: store.syncInbox(refreshedCaller.node.nodeId) });
        return;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        printJson({ messages: [] });
        return;
      }
      await Bun.sleep(Math.min(100, remainingMs));
    }
  } finally {
    store.close();
  }
}

async function runMessage(arguments_: ParsedArguments): Promise<void> {
  if (arguments_.positionals[1] !== "send") throw new Error("message action must be send");
  const recipientNodeId = requiredFlag(arguments_, "to");
  const body = requiredFlag(arguments_, "body");
  const priorityText = optionalFlag(arguments_, "priority") ?? "4";
  const priority = Number.parseInt(priorityText, 10);
  if (!Number.isInteger(priority) || priority < 0 || priority > 10) {
    throw new Error("--priority must be an integer from 0 to 10");
  }
  const kind = optionalFlag(arguments_, "kind") ?? "progress";
  if (kind !== "progress" && kind !== "result") {
    throw new Error("--kind must be progress or result");
  }
  await withAuthenticatedAgentStore(arguments_, (store, caller) => {
    printJson(
      store.sendMessage({
        messageId: createId(),
        treeId: caller.node.treeId,
        senderNodeId: caller.node.nodeId,
        recipientNodeId,
        channel: "inbox",
        kind,
        priority,
        replyToMessageId: null,
        body,
      }),
    );
  });
}

async function runMerge(arguments_: ParsedArguments): Promise<void> {
  const childNodeId = requiredFlag(arguments_, "child-node");
  await withAuthenticatedAgentStore(arguments_, async (store, caller) => {
    const controller = new MergeController(store);
    printJson(
      await controller.mergeChild({
        parentPaneId: caller.callerPaneId,
        childNodeId,
      }),
    );
  });
}

function databasePathForState(statePath: string): string {
  return join(resolve(statePath), "state.sqlite");
}

function defaultStatePath(runId: string): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "sheltie", "runs", runId);
}

function readRunSnapshot(statePath: string): ObservationSnapshot {
  return new ObservationReader(statePath).snapshot();
}

function writeRunProgress(event: "run_reserved" | "run_progress", snapshot: ObservationSnapshot): void {
  process.stderr.write(
    `${JSON.stringify({
      event,
      ...projectObservationLifecycle(snapshot),
    })}\n`,
  );
}

function printRunControlResult(
  action: "cancel" | "quiesce",
  snapshot: ObservationSnapshot,
  unresolvedOperationCount: number,
): void {
  printJson({
    action,
    observation: snapshot,
    unresolvedOperationCount,
  });
}

async function runUntilSettled(
  controller: RealRunController,
  arguments_: ParsedArguments,
  statePath: string,
): Promise<void> {
  const pollMs = boundedIntegerFlag(arguments_, "poll-ms", 250, 25, 10_000);
  let stopping = false;
  let lastProgress = "";
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (!stopping) {
      await controller.convergeOnce();
      const snapshot = readRunSnapshot(statePath);
      const progress = JSON.stringify(projectObservationLifecycle(snapshot));
      if (progress !== lastProgress) {
        writeRunProgress("run_progress", snapshot);
        lastProgress = progress;
      }
      if (
        arguments_.flags.has("once") ||
        ["completed", "failed", "blocked", "cancelled", "cancel_blocked", "cleaned"].includes(snapshot.run.status)
      ) {
        printJson(snapshot);
        if (["failed", "blocked", "cancel_blocked"].includes(snapshot.run.status)) process.exitCode = 1;
        return;
      }
      await Bun.sleep(pollMs);
    }
    printJson(readRunSnapshot(statePath));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function runRealRun(arguments_: ParsedArguments): Promise<void> {
  const action = arguments_.positionals[1];
  if (action === "start") {
    const runId = optionalFlag(arguments_, "run-id") ?? createId();
    const manifest = resolveManifestFile(resolve(requiredFlag(arguments_, "manifest")));
    const statePath = createPrivateStateDirectory(optionalFlag(arguments_, "state") ?? defaultStatePath(runId));
    const databasePath = databasePathForState(statePath);
    if (existsSync(databasePath)) throw new Error("run state already exists");
    const socketPath = requiredFlag(arguments_, "herdr-socket");
    const store = new SheltieStore(databasePath);
    try {
      const controller = new RealRunController(store, new HerdrClient(socketPath), {
        sheltieExecutable: process.execPath,
        onTreeReserved: () => {
          writeRunProgress("run_reserved", readRunSnapshot(statePath));
        },
      });
      await controller.startRun({
        runId,
        repoRoot: resolve(optionalFlag(arguments_, "repo") ?? process.cwd()),
        base: optionalFlag(arguments_, "base") ?? "HEAD",
        worktreeRoot: join(statePath, "worktrees"),
        manifest,
        herdrSocketPath: socketPath,
      });
      await runUntilSettled(controller, arguments_, statePath);
    } finally {
      store.close();
    }
    return;
  }
  if (action === "cleanup") {
    const statePath = assertPrivateStateDirectory(requiredFlag(arguments_, "state"));
    // Reject an absent or legacy database before this mutable store could create or migrate it.
    readRunSnapshot(statePath);
    const databasePath = databasePathForState(statePath);
    const store = new SheltieStore(databasePath);
    try {
      const tree = store.getOnlyTree();
      const controller = new CleanupController(store, new HerdrClient(tree.herdrSocketPath));
      // Cleanup is an explicit operator-sensitive exact-target workflow.
      const unsafeOutput = arguments_.flags.has("unsafe-output");
      if (arguments_.flags.has("apply")) {
        const result = await controller.apply(optionalFlag(arguments_, "plan-digest"));
        printJson(cleanupApplyOutput(statePath, result, unsafeOutput));
      } else {
        if (arguments_.flags.has("plan-digest")) {
          throw new Error("--plan-digest is only valid with --apply");
        }
        printJson(cleanupPreviewOutput(statePath, await controller.preview(), unsafeOutput));
      }
    } finally {
      store.close();
    }
    return;
  }
  if (action !== "resume" && action !== "status" && action !== "cancel" && action !== "quiesce") {
    throw new Error("run action must be start, resume, status, cancel, quiesce, or cleanup");
  }
  const statePath = assertPrivateStateDirectory(requiredFlag(arguments_, "state"));
  if (action === "status") {
    printJson(readRunSnapshot(statePath));
    return;
  }
  // Reject an absent or legacy database before this mutable store could create or migrate it.
  readRunSnapshot(statePath);
  const databasePath = databasePathForState(statePath);
  const store = new SheltieStore(databasePath);
  try {
    const tree = store.getOnlyTree();
    if (action === "quiesce") {
      const graceMs = boundedIntegerFlag(arguments_, "grace-ms", 5_000, 100, 30_000);
      const result = await new QuiesceController(
        store,
        new HerdrClient(tree.herdrSocketPath),
        { graceMs },
      ).quiesceRun();
      printRunControlResult("quiesce", readRunSnapshot(statePath), result.unresolvedOperations.length);
      if (result.unresolvedOperations.length > 0) process.exitCode = 1;
      return;
    }
    const controller = new RealRunController(store, new HerdrClient(tree.herdrSocketPath), {
      sheltieExecutable: process.execPath,
    });
    if (
      action === "cancel" ||
      (action === "resume" && ["cancel_requested", "cancelling", "cancel_blocked"].includes(tree.status))
    ) {
      const graceMs = boundedIntegerFlag(arguments_, "grace-ms", 5_000, 100, 30_000);
      const cancellation = new CancellationController(
        store,
        new HerdrClient(tree.herdrSocketPath),
        { graceMs },
      );
      const status = await cancellation.cancelRun();
      const snapshot = readRunSnapshot(statePath);
      writeRunProgress("run_progress", snapshot);
      printRunControlResult("cancel", snapshot, status.operations.length);
      if (snapshot.run.status === "cancel_blocked") process.exitCode = 1;
      return;
    }
    await runUntilSettled(controller, arguments_, statePath);
  } finally {
    store.close();
  }
}

async function runReconcile(arguments_: ParsedArguments): Promise<void> {
  if (!arguments_.flags.has("unsafe-output")) {
    throw new Error("reconcile requires --unsafe-output because it emits operator-only runtime records");
  }
  const databasePath = assertPrivateStateParentForDatabase(requiredFlag(arguments_, "db"));
  const statePath = dirname(databasePath);
  if (databasePath !== databasePathForState(statePath)) {
    throw new Error("reconcile requires the canonical state.sqlite database");
  }
  // Raw reconciliation is permitted only for an already-current canonical state database.
  readRunSnapshot(statePath);
  const treeId = requiredFlag(arguments_, "tree-id");
  const store = new SheltieStore(databasePath);
  try {
    const tree = store.getTree(treeId);
    const orchestrator = new SheltieOrchestrator(store, new HerdrClient(tree.herdrSocketPath), {
      sheltieExecutable: process.execPath,
    });
    // Reconciliation output carries runtime locators, so it is never a normal lifecycle surface.
    const nodes = [];
    for (const node of store.listNodes(treeId)) nodes.push(await orchestrator.reconcileNode(node.nodeId));
    printJson({ nodes });
  } finally {
    store.close();
  }
}


export async function runCli(argv: string[]): Promise<void> {
  const arguments_ = parseArguments(argv);
  const command = arguments_.positionals[0];
  if (command === "manifest") runManifest(arguments_);
  else if (command === "observe") runObserve(arguments_);
  else if (command === "run") await runRealRun(arguments_);
  else if (command === "spawn") await runSpawn(arguments_);
  else if (command === "step") await runStep(arguments_);
  else if (command === "node") await runNode(arguments_);
  else if (command === "sync") await runSync(arguments_);
  else if (command === "message") await runMessage(arguments_);
  else if (command === "merge") await runMerge(arguments_);
  else if (command === "reconcile") await runReconcile(arguments_);
  else {
    process.stderr.write(usage());
    process.exitCode = command === undefined || command === "help" ? 0 : 2;
  }
}

export function formatExecutableError(argv: string[], error: unknown): string {
  const arguments_ = parseArguments(argv);
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (arguments_.flags.has("unsafe-output")) return rawMessage;
  const command = arguments_.positionals[0];
  return command === "run" || command === "observe" ? "sheltie command failed" : rawMessage;
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatExecutableError(process.argv.slice(2), error)}\n`);
    process.exitCode = 1;
  }
}
