import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";

const OWNER_ONLY_MODE_MASK = 0o077;

function fail(message: string): never {
  throw new Error(`state security check failed: ${message}`);
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
  if (typeof process.geteuid !== "function") fail("effective uid is unavailable");
  return process.geteuid();
}

/**
 * Validates the final directory that owns a Sheltie SQLite state database.
 *
 * The final directory must be a real, owner-only directory. We intentionally do
 * not repair permissions: a caller must explicitly choose a safe state location.
 */
export function assertPrivateStateDirectory(stateDirectory: string, label = "state directory"): string {
  const resolvedDirectory = resolve(stateDirectory);
  const details = lstatIfPresent(resolvedDirectory);
  if (details === null) fail(`${label} is missing`);
  if (details.isSymbolicLink()) fail(`${label} must not be a symbolic link`);
  if (!details.isDirectory()) fail(`${label} must be a directory`);
  if (details.uid !== effectiveUid()) fail(`${label} is not owned by the effective uid`);
  if ((details.mode & OWNER_ONLY_MODE_MASK) !== 0) fail(`${label} grants group or other access`);
  return resolvedDirectory;
}

/** Creates one new private state directory, then validates it before database use. */
export function createPrivateStateDirectory(stateDirectory: string): string {
  const resolvedDirectory = resolve(stateDirectory);
  if (lstatIfPresent(resolvedDirectory) === null) {
    mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
  }
  return assertPrivateStateDirectory(resolvedDirectory);
}

/** Validates the private state parent before any database connection is opened. */
export function assertPrivateStateParentForDatabase(databasePath: string): string {
  const resolvedDatabasePath = resolve(databasePath);
  assertPrivateStateDirectory(dirname(resolvedDatabasePath), "state database parent");
  return resolvedDatabasePath;
}
