#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CancellationController } from "./cancel.ts";
import { commitExistsOnBranch, isCleanWorktree } from "./git.ts";
import { HerdrClient } from "./herdr-client.ts";
import { createId } from "./ids.ts";
import { MergeController } from "./merge.ts";
import { SheltieOrchestrator } from "./orchestrator.ts";
import { runPoc } from "./poc-runner.ts";
import { SheltieStore } from "./db.ts";
import { RealRunController, type RealRunStatus } from "./run.ts";

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

function readTaskContract(arguments_: ParsedArguments): string {
  const taskText = optionalFlag(arguments_, "task");
  const taskFile = optionalFlag(arguments_, "task-file");
  if ((taskText === undefined) === (taskFile === undefined)) {
    throw new Error("exactly one of --task or --task-file is required");
  }
  return taskText ?? readFileSync(taskFile as string, "utf8");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage(): string {
  return `sheltie commands:
  sheltie run start --repo PATH --task-file PATH --herdr-socket PATH [--base REF] [--state PATH] [--once]
  sheltie run resume --state PATH [--once]
  sheltie run cancel --state PATH [--grace-ms N]
  sheltie run status --state PATH
  sheltie spawn --db PATH --parent-pane ID --request-key KEY --name NAME (--task TEXT | --task-file PATH)
  sheltie step claim --db PATH --operation-id ID [--agent-session ID]
  sheltie step complete --db PATH --operation-id ID --commit SHA [--agent-session ID]
  sheltie node finish --db PATH --node-id ID [--agent-session ID]
  sheltie sync --db PATH --node-id ID [--wait-ms N]
  sheltie merge --db PATH --parent-pane ID --child-node ID
  sheltie message send --db PATH --from NODE --to NODE --body TEXT [--priority N]
  sheltie reconcile --db PATH --tree-id ID
  sheltie poc run [--herdr PATH] [--keep]
`;
}

async function runSpawn(arguments_: ParsedArguments): Promise<void> {
  const databasePath = requiredFlag(arguments_, "db");
  const parentPaneId = requiredFlag(arguments_, "parent-pane");
  const requestKey = requiredFlag(arguments_, "request-key");
  const name = requiredFlag(arguments_, "name");
  const taskContract = readTaskContract(arguments_);
  const store = new SheltieStore(databasePath);
  try {
    const parent = store.findNodeByPane(parentPaneId);
    if (parent === null) throw new Error(`no sheltie node is bound to pane ${parentPaneId}`);
    const tree = store.getTree(parent.treeId);
    const orchestrator = new SheltieOrchestrator(store, new HerdrClient(tree.herdrSocketPath), {
      sheltieExecutable: process.execPath,
    });
    printJson(await orchestrator.reserveChild({ parentPaneId, requestKey, name, taskContract }));
  } finally {
    store.close();
  }
}

function agentSession(arguments_: ParsedArguments): string {
  return optionalFlag(arguments_, "agent-session") ?? process.env.HERDR_PANE_ID ?? "";
}

async function runStep(arguments_: ParsedArguments): Promise<void> {
  const action = arguments_.positionals[1];
  const databasePath = requiredFlag(arguments_, "db");
  const operationId = requiredFlag(arguments_, "operation-id");
  const session = agentSession(arguments_);
  if (session.length === 0) throw new Error("--agent-session or HERDR_PANE_ID is required");
  const store = new SheltieStore(databasePath);
  try {
    if (action === "claim") {
      printJson(store.claimStep(operationId, session));
      return;
    }
    if (action !== "complete") throw new Error("step action must be claim or complete");
    const commitSha = requiredFlag(arguments_, "commit");
    const step = store.getStep(operationId);
    const node = store.getNode(step.nodeId);
    if (!(await commitExistsOnBranch(node.worktreePath, commitSha, "HEAD"))) {
      throw new Error(`commit ${commitSha} is not reachable from node ${node.nodeId} HEAD`);
    }
    if (!(await isCleanWorktree(node.worktreePath))) {
      throw new Error(`node ${node.nodeId} worktree is dirty`);
    }
    store.completeStep({
      operationId,
      agentSession: session,
      commitSha,
      resultMessageId: null,
    });
    store.setOperationStatus(operationId, "completed", { result: { commitSha } });
    printJson(store.getStep(operationId));
  } finally {
    store.close();
  }
}

function runNode(arguments_: ParsedArguments): void {
  if (arguments_.positionals[1] !== "finish") throw new Error("node action must be finish");
  const session = agentSession(arguments_);
  if (session.length === 0) throw new Error("--agent-session or HERDR_PANE_ID is required");
  const store = new SheltieStore(requiredFlag(arguments_, "db"));
  try {
    printJson(store.finishNode(requiredFlag(arguments_, "node-id"), session));
  } finally {
    store.close();
  }
}

async function runSync(arguments_: ParsedArguments): Promise<void> {
  const store = new SheltieStore(requiredFlag(arguments_, "db"));
  const nodeId = requiredFlag(arguments_, "node-id");
  const waitMs = boundedIntegerFlag(arguments_, "wait-ms", 0, 0, 180_000);
  const deadline = Date.now() + waitMs;
  try {
    while (true) {
      const messages = store.syncInbox(nodeId);
      if (messages.length > 0 || Date.now() >= deadline) {
        printJson({ messages });
        return;
      }
      await Bun.sleep(100);
    }
  } finally {
    store.close();
  }
}

function runMessage(arguments_: ParsedArguments): void {
  if (arguments_.positionals[1] !== "send") throw new Error("message action must be send");
  const store = new SheltieStore(requiredFlag(arguments_, "db"));
  try {
    const senderNodeId = requiredFlag(arguments_, "from");
    const sender = store.getNode(senderNodeId);
    const priorityText = optionalFlag(arguments_, "priority") ?? "4";
    const priority = Number.parseInt(priorityText, 10);
    if (!Number.isInteger(priority) || priority < 0 || priority > 10) {
      throw new Error("--priority must be an integer from 0 to 10");
    }
    printJson(
      store.sendMessage({
        messageId: createId(),
        treeId: sender.treeId,
        senderNodeId,
        recipientNodeId: requiredFlag(arguments_, "to"),
        channel: "inbox",
        priority,
        replyToMessageId: null,
        body: requiredFlag(arguments_, "body"),
      }),
    );
  } finally {
    store.close();
  }
}

async function runMerge(arguments_: ParsedArguments): Promise<void> {
  const parentPaneId = optionalFlag(arguments_, "parent-pane") ?? process.env.HERDR_PANE_ID ?? "";
  if (parentPaneId.length === 0) throw new Error("--parent-pane or HERDR_PANE_ID is required");
  const store = new SheltieStore(requiredFlag(arguments_, "db"));
  try {
    const controller = new MergeController(store);
    printJson(
      await controller.mergeChild({
        parentPaneId,
        childNodeId: requiredFlag(arguments_, "child-node"),
      }),
    );
  } finally {
    store.close();
  }
}

function databasePathForState(statePath: string): string {
  return join(resolve(statePath), "state.sqlite");
}

function defaultStatePath(runId: string): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "sheltie", "runs", runId);
}

function writeRunProgress(status: RealRunStatus, statePath: string): void {
  process.stderr.write(
    `${JSON.stringify({
      event: "run_progress",
      runId: status.tree.runId,
      statePath,
      status: status.tree.status,
      nodes: status.nodes.map((node) => ({ nodeId: node.nodeId, status: node.lifecycleStatus })),
      unresolvedOperations: status.operations.length,
    })}\n`,
  );
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
      const status = await controller.convergeOnce();
      const progress = JSON.stringify({
        tree: status.tree.status,
        nodes: status.nodes.map((node) => [node.nodeId, node.lifecycleStatus]),
        operations: status.operations.map((operation) => [operation.operationId, operation.status]),
      });
      if (progress !== lastProgress) {
        writeRunProgress(status, statePath);
        lastProgress = progress;
      }
      if (
        arguments_.flags.has("once") ||
        ["completed", "failed", "blocked", "cancelled", "cancel_blocked"].includes(status.tree.status)
      ) {
        printJson({ statePath, ...status });
        if (["failed", "blocked", "cancel_blocked"].includes(status.tree.status)) process.exitCode = 1;
        return;
      }
      await Bun.sleep(pollMs);
    }
    printJson({ statePath, ...controller.status() });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function runRealRun(arguments_: ParsedArguments): Promise<void> {
  const action = arguments_.positionals[1];
  if (action === "start") {
    const runId = optionalFlag(arguments_, "run-id") ?? createId();
    const statePath = resolve(optionalFlag(arguments_, "state") ?? defaultStatePath(runId));
    const databasePath = databasePathForState(statePath);
    if (existsSync(databasePath)) throw new Error(`run state already exists at ${databasePath}`);
    mkdirSync(statePath, { recursive: true });
    const socketPath = requiredFlag(arguments_, "herdr-socket");
    const store = new SheltieStore(databasePath);
    try {
      const controller = new RealRunController(store, new HerdrClient(socketPath), {
        sheltieExecutable: process.execPath,
        onTreeReserved: (tree) => {
          process.stderr.write(`${JSON.stringify({ event: "run_reserved", runId: tree.runId, statePath })}\n`);
        },
      });
      await controller.startRun({
        runId,
        repoRoot: resolve(optionalFlag(arguments_, "repo") ?? process.cwd()),
        base: optionalFlag(arguments_, "base") ?? "HEAD",
        worktreeRoot: join(statePath, "worktrees"),
        taskContract: readTaskContract(arguments_),
        herdrSocketPath: socketPath,
      });
      await runUntilSettled(controller, arguments_, statePath);
    } finally {
      store.close();
    }
    return;
  }
  if (action !== "resume" && action !== "status" && action !== "cancel") {
    throw new Error("run action must be start, resume, status, or cancel");
  }
  const statePath = resolve(requiredFlag(arguments_, "state"));
  const databasePath = databasePathForState(statePath);
  if (!existsSync(databasePath)) throw new Error(`run state does not exist at ${databasePath}`);
  const store = new SheltieStore(databasePath);
  try {
    const tree = store.getOnlyTree();
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
      writeRunProgress(status, statePath);
      printJson({ statePath, ...status });
      if (status.tree.status === "cancel_blocked") process.exitCode = 1;
      return;
    }
    if (action === "status") {
      printJson({ statePath, ...controller.status() });
      return;
    }
    await runUntilSettled(controller, arguments_, statePath);
  } finally {
    store.close();
  }
}

async function runReconcile(arguments_: ParsedArguments): Promise<void> {
  const store = new SheltieStore(requiredFlag(arguments_, "db"));
  const treeId = requiredFlag(arguments_, "tree-id");
  const tree = store.getTree(treeId);
  const orchestrator = new SheltieOrchestrator(store, new HerdrClient(tree.herdrSocketPath), {
    sheltieExecutable: process.execPath,
  });
  try {
    const nodes = [];
    for (const node of store.listNodes(treeId)) nodes.push(await orchestrator.reconcileNode(node.nodeId));
    printJson({ nodes });
  } finally {
    store.close();
  }
}


async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const command = arguments_.positionals[0];
  if (command === "run") await runRealRun(arguments_);
  else if (command === "spawn") await runSpawn(arguments_);
  else if (command === "step") await runStep(arguments_);
  else if (command === "node") runNode(arguments_);
  else if (command === "sync") await runSync(arguments_);
  else if (command === "message") runMessage(arguments_);
  else if (command === "merge") await runMerge(arguments_);
  else if (command === "reconcile") await runReconcile(arguments_);
  else if (command === "poc" && arguments_.positionals[1] === "run") {
    const herdrBinary = optionalFlag(arguments_, "herdr");
    await runPoc({
      ...(herdrBinary === undefined ? {} : { herdrBinary }),
      keep: arguments_.flags.has("keep"),
    });
  } else {
    process.stderr.write(usage());
    process.exitCode = command === undefined || command === "help" ? 0 : 2;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
