import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatExecutableError,
  projectCleanupApplyResult,
  projectCleanupPlan,
  runCli,
} from "../src/cli.ts";
import { SheltieStore, type TreeStatus } from "../src/db.ts";
import { resolveManifestFile } from "../src/manifest.ts";
import type { CleanupPlan } from "../src/cleanup.ts";


const roots: string[] = [];
const servers: Server[] = [];

const FORBIDDEN_VALUES = [
  "STATE_PATH_MUST_NOT_LEAK",
  "REPOSITORY_PATH_MUST_NOT_LEAK",
  "WORKTREE_PATH_MUST_NOT_LEAK",
  "HERDR_SOCKET_MUST_NOT_LEAK",
  "PROMPT_BODY_MUST_NOT_LEAK",
  "TASK_CONTRACT_MUST_NOT_LEAK",
  "PARAMETER_VALUE_MUST_NOT_LEAK",
  "WORKSPACE_ID_MUST_NOT_LEAK",
  "PANE_ID_MUST_NOT_LEAK",
  "AGENT_ID_MUST_NOT_LEAK",
  "AGENT_SESSION_MUST_NOT_LEAK",
  "TERMINAL_ID_MUST_NOT_LEAK",
  "AGENT_INSTANCE_MUST_NOT_LEAK",
  "RAW_OPERATION_PAYLOAD_MUST_NOT_LEAK",
  "RAW_OPERATION_RESULT_MUST_NOT_LEAK",
  "PROMPT_SHA_MUST_NOT_LEAK",
  "MESSAGE_BODY_MUST_NOT_LEAK",
] as const;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  stateDirectory: string;
  socketPath: string;
}

interface CapturedOutput {
  stdout: string;
  stderr: string;
}

function createFixture(
  status: TreeStatus,
  includeAgentIdentity = true,
  unresolvedOperationCount = 0,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sheltie-cli-output-"));
  roots.push(root);
  const stateDirectory = join(root, "STATE_PATH_MUST_NOT_LEAK");
  mkdirSync(stateDirectory, { mode: 0o700 });
  const socketPath = join(root, "HERDR_SOCKET_MUST_NOT_LEAK.sock");
  const manifestPath = join(stateDirectory, "sheltie.yaml");
  writeFileSync(
    manifestPath,
    `apiVersion: sheltie.dev/v1alpha1
kind: Run
metadata:
  name: cli-output-safety
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
        inline: "PROMPT_BODY_MUST_NOT_LEAK"
      capabilities:
        spawn:
          roles: [worker]
        mergeChildren: false
        messaging:
          sendTo: [children]
          receiveFrom: [children]
    worker:
      placement: tab
      agent:
        kind: omp
      prompt:
        inline: "worker"
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent]
      executionPolicy:
        workspace: read-only
`,
  );
  const manifest = resolveManifestFile(manifestPath);
  const role = manifest.manifest.spec.roles.coordinator;
  if (role === undefined) throw new Error("fixture coordinator role is missing");
  const workerRole = manifest.manifest.spec.roles.worker;
  if (workerRole === undefined) throw new Error("fixture worker role is missing");

  const store = new SheltieStore(join(stateDirectory, "state.sqlite"));
  try {
    store.createManifestTree(
      {
        manifestDigest: manifest.digest,
        apiVersion: manifest.manifest.apiVersion,
        resolved: manifest.manifest,
      },
      {
        treeId: "tree-output-safety",
        runId: "run-output-safety",
        repoRoot: "/REPOSITORY_PATH_MUST_NOT_LEAK",
        repoSourceWorkspaceId: null,
        herdrSocketPath: socketPath,
        herdrVersion: "0.8.0",
        herdrProtocol: 20,
        baseCommit: "a".repeat(40),
        worktreeRoot: "/WORKTREE_PATH_MUST_NOT_LEAK",
        rootTaskContract: "TASK_CONTRACT_MUST_NOT_LEAK",
        rootSpawnPolicy: "workspace",
        manifestDigest: manifest.digest,
        rootRole: role.name,
        status: "active",
      },
    );
    store.reserveNode({
      nodeId: "node-public-root",
      treeId: "tree-output-safety",
      parentNodeId: null,
      name: "root",
      depth: 0,
      placement: "workspace",
      spawnPolicy: "workspace",
      branch: "branch-not-public",
      baseCommit: "a".repeat(40),
      worktreePath: "/WORKTREE_PATH_MUST_NOT_LEAK/root",
      taskContract: "TASK_CONTRACT_MUST_NOT_LEAK",
      roleName: role.name,
      roleDigest: role.digest,
      parameters: { token: "PARAMETER_VALUE_MUST_NOT_LEAK" },
      resolvedCapabilities: role.capabilities,
    });
    store.bindWorktree("node-public-root", {
      workspaceId: "WORKSPACE_ID_MUST_NOT_LEAK",
      tabId: "WORKSPACE_ID_MUST_NOT_LEAK:tab",
      paneId: "PANE_ID_MUST_NOT_LEAK",
    });
    if (includeAgentIdentity) {
      store.bindAgent("node-public-root", {
        agentName: "AGENT_ID_MUST_NOT_LEAK",
        agentSession: "AGENT_SESSION_MUST_NOT_LEAK",
        terminalId: "TERMINAL_ID_MUST_NOT_LEAK",
        agentInstanceId: "AGENT_INSTANCE_MUST_NOT_LEAK",
      });
    }
    store.reserveNode({
      nodeId: "node-public-worker",
      treeId: "tree-output-safety",
      parentNodeId: "node-public-root",
      name: "worker",
      depth: 1,
      placement: "tab",
      spawnPolicy: "none",
      branch: "branch-not-public",
      baseCommit: "a".repeat(40),
      worktreePath: "/WORKTREE_PATH_MUST_NOT_LEAK/root",
      taskContract: "worker",
      roleName: workerRole.name,
      roleDigest: workerRole.digest,
      parameters: {},
      resolvedCapabilities: workerRole.capabilities,
    });
    store.setNodeLifecycle("node-public-worker", "completed");
    store.reserveOperation({
      operationId: "operation-private",
      treeId: "tree-output-safety",
      nodeId: "node-public-root",
      kind: "spawn",
      requestKey: "request-private",
      requestHash: "hash-private",
      request: { payload: "RAW_OPERATION_PAYLOAD_MUST_NOT_LEAK" },
    });
    store.setOperationStatus("operation-private", "completed", {
      result: { payload: "RAW_OPERATION_RESULT_MUST_NOT_LEAK" },
    });
    for (let index = 0; index < unresolvedOperationCount; index += 1) {
      store.reserveOperation({
        operationId: `unresolved-operation-${index}`,
        treeId: "tree-output-safety",
        nodeId: "node-public-root",
        kind: "spawn",
        requestKey: `unresolved-request-${index}`,
        requestHash: `unresolved-hash-${index}`,
        request: {},
      });
    }
    store.reserveStep({
      operationId: "step-private",
      nodeId: "node-public-root",
      runNumber: 1,
      iterationNumber: 1,
      stepNumber: 1,
      promptSha256: "PROMPT_SHA_MUST_NOT_LEAK",
    });
    store.sendMessage({
      messageId: "message-private",
      treeId: "tree-output-safety",
      senderNodeId: "node-public-root",
      recipientNodeId: "node-public-worker",
      channel: "inbox",
      kind: "progress",
      priority: 4,
      replyToMessageId: null,
      body: "MESSAGE_BODY_MUST_NOT_LEAK",
    });
    store.setNodeLifecycle("node-public-root", "completed");
    if (status !== "active") store.setTreeStatus("tree-output-safety", status);
  } finally {
    store.close();
  }
  return { stateDirectory, socketPath };
}

async function servePong(socketPath: string, capabilities: Record<string, unknown> | null): Promise<void> {
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as { id: string; method: string };
      socket.end(
        `${JSON.stringify({
          id: request.id,
          result: { type: "pong", version: "0.8.0", protocol: 20, capabilities },
        })}\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function serveCleanupInventory(socketPath: string): Promise<void> {
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as { id: string; method: string };
      const result =
        request.method === "ping"
          ? { type: "pong", version: "0.8.0", protocol: 20, capabilities: null }
          : request.method === "session.snapshot"
            ? {
                type: "session_snapshot",
                snapshot: { version: "0.8.0", protocol: 20, workspaces: [], tabs: [], panes: [], agents: [] },
              }
            : request.method === "worktree.list"
              ? {
                  type: "worktree_list",
                  source: { repo_root: "/REPOSITORY_PATH_MUST_NOT_LEAK" },
                  worktrees: [],
                }
              : undefined;
      socket.end(
        `${JSON.stringify(
          result === undefined
            ? { id: request.id, error: { code: "unsupported", message: "unsupported cleanup request" } }
            : { id: request.id, result },
        )}\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function captureOutput(operation: () => Promise<void>): Promise<CapturedOutput> {
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  const previousExitCode = process.exitCode;
  try {
    await operation();
    return {
      stdout: stdout.mock.calls.map(([value]) => String(value)).join(""),
      stderr: stderr.mock.calls.map(([value]) => String(value)).join(""),
    };
  } finally {
    process.exitCode = previousExitCode;
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("normal run CLI output", () => {
  test("projects status, progress, cancel, and quiesce through the safe observation surface", async () => {
    const statusFixture = createFixture("completed");
    const statusOutput = await captureOutput(() =>
      runCli(["run", "status", "--state", statusFixture.stateDirectory]),
    );

    const resumeFixture = createFixture("completed");
    await servePong(resumeFixture.socketPath, null);
    const resumeOutput = await captureOutput(() =>
      runCli(["run", "resume", "--state", resumeFixture.stateDirectory, "--once"]),
    );

    const cancelFixture = createFixture("cleaned", true, 2);
    const cancelOutput = await captureOutput(() =>
      runCli(["run", "cancel", "--state", cancelFixture.stateDirectory]),
    );

    const quiesceFixture = createFixture("completed", false);
    await servePong(quiesceFixture.socketPath, { agent_control: true });
    const quiesceOutput = await captureOutput(() =>
      runCli(["run", "quiesce", "--state", quiesceFixture.stateDirectory]),
    );

    const output = [statusOutput, resumeOutput, cancelOutput, quiesceOutput]
      .map(({ stdout, stderr }) => `${stdout}${stderr}`)
      .join("");
    for (const forbidden of FORBIDDEN_VALUES) expect(output).not.toContain(forbidden);
    expect(resumeOutput.stderr).toContain('"event":"run_progress"');
    expect(resumeOutput.stderr).not.toContain("node-public-root");
    expect(cancelOutput.stderr).not.toContain("node-public-root");
    expect(cancelOutput.stdout).toContain('"action":"cancel"');
    expect(cancelOutput.stdout).toContain('"unresolvedOperationCount":2');
    expect(quiesceOutput.stdout).toContain('"action":"quiesce"');
  });

  test("requires an explicit unsafe-output opt-in for raw reconciliation records", async () => {
    const fixture = createFixture("completed");

    await expect(
      runCli([
        "reconcile",
        "--db",
        join(fixture.stateDirectory, "state.sqlite"),
        "--tree-id",
        "tree-output-safety",
      ]),
    ).rejects.toThrow("--unsafe-output");
  });
});

describe("cleanup CLI output", () => {
  test("projects normal cleanup output while retaining raw targets only with unsafe-output", async () => {
    const rawPlan: Pick<
      CleanupPlan,
      "planDigest" | "treeGeneration" | "manifestDigest" | "actions" | "blockers"
    > = {
      planDigest: "a".repeat(64),
      treeGeneration: 7,
      manifestDigest: "b".repeat(64),
      actions: [
        {
          kind: "remove_worktree",
          nodeId: FORBIDDEN_VALUES[0],
          workspaceId: FORBIDDEN_VALUES[1],
          worktreePath: FORBIDDEN_VALUES[2],
          branch: FORBIDDEN_VALUES[3],
          headCommitSha: FORBIDDEN_VALUES[4],
          paneIds: [FORBIDDEN_VALUES[5]],
          tabIds: [FORBIDDEN_VALUES[6]],
          terminalIds: [FORBIDDEN_VALUES[7]],
        },
      ],
      blockers: [...FORBIDDEN_VALUES],
    };
    const projectedPlan = projectCleanupPlan(rawPlan);
    const projectedApply = projectCleanupApplyResult({
      plan: rawPlan,
      receipts: FORBIDDEN_VALUES,
      duplicate: false,
    });
    const projectedOutput = JSON.stringify({ projectedPlan, projectedApply });
    for (const forbidden of FORBIDDEN_VALUES) expect(projectedOutput).not.toContain(forbidden);
    expect(projectedPlan).toEqual({
      planDigest: rawPlan.planDigest,
      treeGeneration: 7,
      manifestDigest: rawPlan.manifestDigest,
      actionCount: 1,
      blockerCount: FORBIDDEN_VALUES.length,
    });
    expect(projectedApply).toEqual({
      plan: projectedPlan,
      receiptCount: FORBIDDEN_VALUES.length,
      duplicate: false,
    });

    const safeFixture = createFixture("completed");
    await serveCleanupInventory(safeFixture.socketPath);
    const safeOutput = await captureOutput(() =>
      runCli(["run", "cleanup", "--state", safeFixture.stateDirectory]),
    );
    const safeResult = JSON.parse(safeOutput.stdout) as {
      mode: string;
      plan: Record<string, unknown>;
    };
    expect(safeResult.mode).toBe("preview");
    expect(safeResult.plan).toEqual({
      planDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      treeGeneration: expect.any(Number),
      manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      actionCount: expect.any(Number),
      blockerCount: expect.any(Number),
    });
    for (const forbidden of FORBIDDEN_VALUES) {
      expect(`${safeOutput.stdout}${safeOutput.stderr}`).not.toContain(forbidden);
    }

    const unsafeFixture = createFixture("completed");
    await serveCleanupInventory(unsafeFixture.socketPath);
    const unsafeOutput = await captureOutput(() =>
      runCli(["run", "cleanup", "--state", unsafeFixture.stateDirectory, "--unsafe-output"]),
    );
    const unsafeResult = JSON.parse(unsafeOutput.stdout) as {
      statePath: string;
      mode: string;
      plan: { repoRoot: string; herdrSocketPath: string; blockers: string[] };
    };
    expect(unsafeResult).toMatchObject({
      statePath: unsafeFixture.stateDirectory,
      mode: "preview",
      plan: {
        repoRoot: "/REPOSITORY_PATH_MUST_NOT_LEAK",
        herdrSocketPath: unsafeFixture.socketPath,
      },
    });
    expect(unsafeResult.plan.blockers.join("\n")).toContain("WORKTREE_PATH_MUST_NOT_LEAK");
  });
});

describe("executable lifecycle errors", () => {
  test("formats normal lifecycle errors safely without hiding Agent protocol errors", () => {
    const error = new Error(FORBIDDEN_VALUES.join("|"));
    const safeRunError = formatExecutableError(["run", "resume"], error);
    const safeObservationError = formatExecutableError(["observe", "snapshot"], error);

    expect(safeRunError).toBe("sheltie command failed");
    expect(safeObservationError).toBe("sheltie command failed");
    for (const forbidden of FORBIDDEN_VALUES) {
      expect(safeRunError).not.toContain(forbidden);
      expect(safeObservationError).not.toContain(forbidden);
    }
    expect(formatExecutableError(["run", "resume", "--unsafe-output"], error)).toBe(error.message);
    expect(formatExecutableError(["message", "send"], error)).toBe(error.message);
  });
});
