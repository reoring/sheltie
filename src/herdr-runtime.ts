import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { HerdrClient, type PongResult } from "./herdr-client.ts";
import { parseRuntimeBinding, type BundledRuntimeBinding } from "./runtime-bundle.ts";

const REQUIRED_HERDR_VERSION = "0.8.0";
const REQUIRED_HERDR_PROTOCOL = 20;
const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 20_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PING_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 50;
const PRIVATE_FILE_MODE_MASK = 0o077;

const HERDR_AGENT_OMP_PATH = "HERDR_AGENT_OMP_PATH";

export interface BundledHerdrRuntimeStatusBase {
  sessionName: string;
  socketPath: string;
}

export interface BundledHerdrRuntimeRunningStatus extends BundledHerdrRuntimeStatusBase {
  state: "running";
  version: string;
  protocol: number;
}

export interface BundledHerdrRuntimeStoppedStatus extends BundledHerdrRuntimeStatusBase {
  state: "stopped";
}

export interface BundledHerdrRuntimeIncompatibleStatus extends BundledHerdrRuntimeStatusBase {
  state: "incompatible";
  version: string;
  protocol: number;
}

export type BundledHerdrRuntimeStatus =
  | BundledHerdrRuntimeRunningStatus
  | BundledHerdrRuntimeStoppedStatus
  | BundledHerdrRuntimeIncompatibleStatus;

export interface BundledHerdrSpawnInput {
  argv: readonly string[];
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

export interface BundledHerdrProcess {
  /** Idempotently terminates the exact child and resolves only after it exits. */
  terminate(): Promise<void>;
  exited: Promise<number>;
}

export interface BundledHerdrCommandInput {
  argv: readonly string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export interface BundledHerdrCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Dependencies are explicit so lifecycle tests never need to start Herdr. */
export interface BundledHerdrRuntimeDependencies {
  createClient?: (socketPath: string, timeoutMs: number) => HerdrClient;
  spawn?: (input: BundledHerdrSpawnInput) => BundledHerdrProcess;
  run?: (input: BundledHerdrCommandInput) => Promise<BundledHerdrCommandResult>;
  attach?: (input: BundledHerdrAttachInput) => Promise<number>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
}

export interface BundledHerdrAttachInput {
  argv: readonly string[];
  env: Record<string, string>;
}

function runtimeFailure(message: string): never {
  throw new Error(`bundled Herdr runtime failed: ${message}`);
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function effectiveUid(): number {
  if (typeof process.geteuid !== "function") runtimeFailure("effective uid is unavailable");
  return process.geteuid();
}

function assertPrivateLogParent(path: string): void {
  const details = lstatIfPresent(path);
  if (details === null) runtimeFailure(`private log parent is missing: ${path}`);
  if (details.isSymbolicLink()) runtimeFailure(`private log parent must not be a symbolic link: ${path}`);
  if (!details.isDirectory()) runtimeFailure(`private log parent must be a directory: ${path}`);
  if (details.uid !== effectiveUid()) runtimeFailure(`private log parent is not owned by the effective uid: ${path}`);
  if ((details.mode & PRIVATE_FILE_MODE_MASK) !== 0) {
    runtimeFailure(`private log parent grants group or other access: ${path}`);
  }
}

function openPrivateLog(path: string): number {
  assertPrivateLogParent(dirname(path));
  const existing = lstatIfPresent(path);
  if (existing?.isSymbolicLink()) runtimeFailure(`private log must not be a symbolic link: ${path}`);
  if (existing !== null && !existing.isFile()) runtimeFailure(`private log must be a regular file: ${path}`);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") runtimeFailure(`private log must not be a symbolic link: ${path}`);
    throw error;
  }
  const details = fstatSync(descriptor);
  if (!details.isFile()) {
    closeSync(descriptor);
    runtimeFailure(`private log must be a regular file: ${path}`);
  }
  if (details.uid !== effectiveUid()) {
    closeSync(descriptor);
    runtimeFailure(`private log is not owned by the effective uid: ${path}`);
  }
  if ((details.mode & PRIVATE_FILE_MODE_MASK) !== 0) {
    closeSync(descriptor);
    runtimeFailure(`private log grants group or other access: ${path}`);
  }
  return descriptor;
}

async function waitForProcessExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  const timeout = Promise.withResolvers<false>();
  const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
  try {
    return await Promise.race([
      exited.then(
        () => true as const,
        () => true as const,
      ),
      timeout.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function defaultSpawn(input: BundledHerdrSpawnInput): BundledHerdrProcess {
  const stdout = openPrivateLog(input.stdoutPath);
  const stderr = openPrivateLog(input.stderrPath);
  try {
    const child = Bun.spawn([...input.argv], {
      detached: true,
      env: input.env,
      stdin: "ignore",
      stdout,
      stderr,
    });
    let hasExited = false;
    const exited = child.exited.finally(() => {
      hasExited = true;
    });
    child.unref();
    return {
      exited,
      terminate: async () => {
        if (hasExited) return;
        child.kill("SIGTERM");
        if (await waitForProcessExit(exited, PROCESS_TERMINATION_GRACE_MS)) return;
        child.kill("SIGKILL");
        await exited;
      },
    };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

async function defaultRun(input: BundledHerdrCommandInput): Promise<BundledHerdrCommandResult> {
  const process = Bun.spawn([...input.argv], {
    env: input.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill("SIGTERM");
    hardKillTimer = setTimeout(() => process.kill("SIGKILL"), 1_000);
  }, input.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]).finally(() => {
    clearTimeout(timer);
    clearTimeout(hardKillTimer);
  });
  if (timedOut) runtimeFailure(`${input.argv[0]} timed out after ${input.timeoutMs}ms`);
  return { exitCode, stdout, stderr };
}

async function defaultAttach(input: BundledHerdrAttachInput): Promise<number> {
  const process = Bun.spawn([...input.argv], {
    env: input.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return process.exited;
}

/**
 * Produces the only environment used for a bundled Herdr process or its exact
 * session-stop command. Inherited Herdr routing state is deliberately absent.
 */
export function controlledHerdrEnvironment(
  binding: BundledRuntimeBinding,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const parsed = parseRuntimeBinding(binding);
  if (parsed.mode !== "bundled") runtimeFailure("a bundled runtime binding is required");
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (value !== undefined && !key.startsWith("HERDR_")) environment[key] = value;
  }
  environment[HERDR_AGENT_OMP_PATH] = parsed.omp.path;
  const inheritedPath = environment.PATH;
  environment.XDG_CONFIG_HOME = parsed.configHome;
  environment.PATH = inheritedPath === undefined || inheritedPath.length === 0
    ? parsed.pathPrefix
    : `${parsed.pathPrefix}:${inheritedPath}`;
  return environment;
}

export class BundledHerdrRuntime {
  readonly binding: BundledRuntimeBinding;
  private readonly createClient: (socketPath: string, timeoutMs: number) => HerdrClient;
  private readonly spawn: (input: BundledHerdrSpawnInput) => BundledHerdrProcess;
  private readonly run: (input: BundledHerdrCommandInput) => Promise<BundledHerdrCommandResult>;
  private readonly delegateAttach: (input: BundledHerdrAttachInput) => Promise<number>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly environment: Record<string, string>;

  constructor(binding: BundledRuntimeBinding, dependencies: BundledHerdrRuntimeDependencies = {}) {
    const parsed = parseRuntimeBinding(binding);
    if (parsed.mode !== "bundled") runtimeFailure("a bundled runtime binding is required");
    this.binding = parsed;
    this.createClient = dependencies.createClient ?? ((socketPath, timeoutMs) => new HerdrClient(socketPath, { timeoutMs }));
    this.spawn = dependencies.spawn ?? defaultSpawn;
    this.run = dependencies.run ?? defaultRun;
    this.delegateAttach = dependencies.attach ?? defaultAttach;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
    this.environment = controlledHerdrEnvironment(parsed, dependencies.environment);
  }

  async attach(): Promise<void> {
    const status = await this.probe(PING_TIMEOUT_MS);
    if (status.state !== "running") {
      runtimeFailure(`exact bundled Herdr session ${this.binding.sessionName} is not available for attach`);
    }
    const exitCode = await this.delegateAttach({
      argv: [this.binding.herdr.path, "session", "attach", this.binding.sessionName],
      env: { ...this.environment },
    });
    if (exitCode !== 0) runtimeFailure(`exact bundled Herdr attach exited ${exitCode}`);
  }

  async status(): Promise<BundledHerdrRuntimeStatus> {
    return this.probe(PING_TIMEOUT_MS);
  }

  async ensureRunning(): Promise<HerdrClient> {
    const existing = await this.probe(PING_TIMEOUT_MS);
    if (existing.state === "running") return this.createClient(this.binding.socketPath, PING_TIMEOUT_MS);

    const spawnedProcess = this.spawn({
      argv: [this.binding.herdr.path, "--session", this.binding.sessionName, "server"],
      env: { ...this.environment },
      stdoutPath: join(this.binding.configHome, "herdr.stdout.log"),
      stderrPath: join(this.binding.configHome, "herdr.stderr.log"),
    });
    let earlyExit: number | Error | null = null;
    void spawnedProcess.exited.then(
      (exitCode) => {
        earlyExit = exitCode;
      },
      (error: unknown) => {
        earlyExit = error instanceof Error ? error : new Error(String(error));
      },
    );
    try {
      const deadline = this.now() + STARTUP_TIMEOUT_MS;
      while (this.now() < deadline) {
        const status = await this.probe(PING_TIMEOUT_MS);
        if (status.state === "running") return this.createClient(this.binding.socketPath, PING_TIMEOUT_MS);
        const observedExit = earlyExit as number | Error | null;
        if (observedExit !== null) {
          const detail = observedExit instanceof Error ? observedExit.message : `exit code ${observedExit}`;
          runtimeFailure(`exact bundled Herdr exited before readiness (${detail})`);
        }
        const remaining = deadline - this.now();
        if (remaining > 0) await this.sleep(Math.min(POLL_INTERVAL_MS, remaining));
      }
      const observedExit = earlyExit as number | Error | null;
      if (observedExit !== null) {
        const detail = observedExit instanceof Error ? observedExit.message : `exit code ${observedExit}`;
        runtimeFailure(`exact bundled Herdr exited before readiness (${detail})`);
      }
      runtimeFailure(`exact bundled Herdr did not answer ping within ${STARTUP_TIMEOUT_MS}ms`);
    } catch (startupError) {
      try {
        await spawnedProcess.terminate();
      } catch (terminationError) {
        throw new AggregateError(
          [startupError, terminationError],
          "bundled Herdr startup failed and exact child termination also failed",
        );
      }
      throw startupError;
    }
  }

  async stop(): Promise<BundledHerdrRuntimeStatus> {
    const before = await this.probe(PING_TIMEOUT_MS);
    if (before.state === "stopped") return before;
    if (before.state === "incompatible") {
      runtimeFailure(`refusing to stop incompatible runtime at ${this.binding.socketPath}`);
    }
    const result = await this.run({
      argv: [this.binding.herdr.path, "session", "stop", this.binding.sessionName],
      env: { ...this.environment },
      timeoutMs: STOP_TIMEOUT_MS,
    });
    const deadline = this.now() + STOP_TIMEOUT_MS;
    while (this.now() < deadline) {
      const current = await this.probe(PING_TIMEOUT_MS);
      if (current.state === "stopped") return current;
      if (current.state === "incompatible") {
        runtimeFailure(`runtime identity changed while stopping ${this.binding.sessionName}`);
      }
      await this.sleep(Math.min(POLL_INTERVAL_MS, deadline - this.now()));
    }
    const afterTimeout = await this.probe(PING_TIMEOUT_MS);
    if (afterTimeout.state === "stopped") return afterTimeout;
    const output = `${result.stderr || result.stdout}`.trim();
    if (result.exitCode !== 0) {
      runtimeFailure(`exact bundled Herdr session stop exited ${result.exitCode}${output.length === 0 ? "" : `: ${output}`}`);
    }
    runtimeFailure(`exact bundled Herdr session ${this.binding.sessionName} remained available after stop`);
  }

  private async probe(timeoutMs: number): Promise<BundledHerdrRuntimeStatus> {
    try {
      const pong = await this.createClient(this.binding.socketPath, timeoutMs).ping();
      return this.statusFromPong(pong);
    } catch {
      return {
        state: "stopped",
        sessionName: this.binding.sessionName,
        socketPath: this.binding.socketPath,
      };
    }
  }

  private statusFromPong(pong: PongResult): BundledHerdrRuntimeStatus {
    if (pong.version === REQUIRED_HERDR_VERSION && pong.protocol === REQUIRED_HERDR_PROTOCOL) {
      return {
        state: "running",
        sessionName: this.binding.sessionName,
        socketPath: this.binding.socketPath,
        version: pong.version,
        protocol: pong.protocol,
      };
    }
    return {
      state: "incompatible",
      sessionName: this.binding.sessionName,
      socketPath: this.binding.socketPath,
      version: pong.version,
      protocol: pong.protocol,
    };
  }
}
