/**
 * Bounded, shell-free invocation of `sheltie observe snapshot --state PATH`.
 *
 * This is the only external call the cockpit makes. The command runs with an
 * exact argv (no shell), a hard timeout, and a stdout size cap. Stderr is
 * ignored at the OS level so raw diagnostics can never enter cockpit state.
 * Failures map onto fixed safe errors via {@link mapSnapshotOutcome}.
 */

import type { Subprocess } from "bun";
import { cockpitError, isCockpitError, type CockpitError } from "./safe-error.ts";
import { decodeObservationSnapshot, type ObservationSnapshot } from "./snapshot.ts";

export const SNAPSHOT_TIMEOUT_MS = 10_000;
export const MAX_SNAPSHOT_STDOUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SHELTIE_EXECUTABLE = "sheltie";
/** Grace window between SIGTERM and SIGKILL when the command must be stopped. */
export const KILL_GRACE_MS = 2_000;
/** Auto refresh cadence when SHELTIE_AUTO_REFRESH_MS is unset. */
export const DEFAULT_AUTO_REFRESH_MS = 2_000;
export const MIN_AUTO_REFRESH_MS = 500;
export const MAX_AUTO_REFRESH_MS = 30_000;

export interface CockpitConfig {
  readonly stateDir: string;
  readonly executable: string;
  /** Cadence used whenever auto refresh is (or becomes) enabled. */
  readonly autoRefreshMs: number;
  /** Whether auto refresh starts enabled. */
  readonly autoRefreshEnabled: boolean;
}

/**
 * Strictly parse SHELTIE_AUTO_REFRESH_MS. Unset/blank means the default
 * cadence, enabled. "0" means disabled (toggling on later uses the default
 * cadence). Anything else must be a whole number of milliseconds within
 * [MIN, MAX]; malformed or out-of-range values fail closed instead of
 * falling back to a default.
 */
function parseAutoRefresh(
  raw: string | undefined,
): Pick<CockpitConfig, "autoRefreshMs" | "autoRefreshEnabled"> | CockpitError {
  if (raw === undefined || raw.trim().length === 0) {
    return { autoRefreshMs: DEFAULT_AUTO_REFRESH_MS, autoRefreshEnabled: true };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return cockpitError("auto-refresh-invalid");
  const value = Number(trimmed);
  if (value === 0) return { autoRefreshMs: DEFAULT_AUTO_REFRESH_MS, autoRefreshEnabled: false };
  if (value < MIN_AUTO_REFRESH_MS || value > MAX_AUTO_REFRESH_MS) {
    return cockpitError("auto-refresh-invalid");
  }
  return { autoRefreshMs: value, autoRefreshEnabled: true };
}

/** Resolve pane configuration from the environment. */
export function readCockpitConfig(
  env: Readonly<Record<string, string | undefined>>,
): CockpitConfig | CockpitError {
  const stateDir = env.SHELTIE_STATE_DIR;
  if (stateDir === undefined || stateDir.trim().length === 0) {
    return cockpitError("state-dir-missing");
  }
  const autoRefresh = parseAutoRefresh(env.SHELTIE_AUTO_REFRESH_MS);
  if (isCockpitError(autoRefresh)) return autoRefresh;
  const executable = env.SHELTIE_EXECUTABLE;
  return {
    stateDir,
    executable:
      executable === undefined || executable.trim().length === 0
        ? DEFAULT_SHELTIE_EXECUTABLE
        : executable,
    ...autoRefresh,
  };
}

/** Exact subprocess argv. Never passes through a shell. */
export function snapshotArgv(executable: string, stateDir: string): string[] {
  return [executable, "observe", "snapshot", "--state", stateDir];
}

export interface SnapshotCommandOutcome {
  readonly timedOut: boolean;
  readonly oversized: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
}

/** Pure mapping from a finished command outcome to a snapshot or safe error. */
export function mapSnapshotOutcome(
  outcome: SnapshotCommandOutcome,
): ObservationSnapshot | CockpitError {
  if (outcome.timedOut) return cockpitError("timeout");
  if (outcome.oversized) return cockpitError("output-too-large");
  if (outcome.exitCode !== 0) return cockpitError("command-failed");
  return decodeObservationSnapshot(outcome.stdout);
}

/** Minimal process surface needed for bounded termination; Bun's Subprocess satisfies it. */
export interface KillableProcess {
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  readonly exited: Promise<number>;
}

/**
 * Stop a process with SIGTERM, escalate to SIGKILL after a bounded grace
 * period. Guarantees `exited` settles even when the child ignores SIGTERM,
 * so no cockpit await can hang on a stuck snapshot command.
 */
export async function terminateWithEscalation(
  proc: KillableProcess,
  graceMs: number,
): Promise<"exited" | "killed"> {
  proc.kill("SIGTERM");
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      proc.exited.then(() => "exited" as const),
      new Promise<"grace-elapsed">((resolve) => {
        graceTimer = setTimeout(() => resolve("grace-elapsed"), graceMs);
      }),
    ]);
    if (outcome === "exited") return "exited";
    proc.kill("SIGKILL");
    await proc.exited;
    return "killed";
  } finally {
    clearTimeout(graceTimer);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<{ text: string; oversized: boolean }> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        onOverflow();
        return { text: "", oversized: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, oversized: false };
}

/** Run one snapshot command and return either a decoded snapshot or a safe error. */
export async function fetchSnapshot(
  config: CockpitConfig,
): Promise<ObservationSnapshot | CockpitError> {
  let proc: Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn({
      cmd: snapshotArgv(config.executable, config.stateDir),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return cockpitError("spawn-failed");
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateWithEscalation(proc, KILL_GRACE_MS);
  }, SNAPSHOT_TIMEOUT_MS);
  try {
    const { text, oversized } = await readBounded(proc.stdout, MAX_SNAPSHOT_STDOUT_BYTES, () => {
      void terminateWithEscalation(proc, KILL_GRACE_MS);
    });
    const exitCode = await proc.exited;
    return mapSnapshotOutcome({ timedOut, oversized, exitCode, stdout: text });
  } finally {
    clearTimeout(timer);
  }
}
