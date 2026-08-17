import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const OUTPUT_DIRECTORY_FLAG = "sheltie-okf-dir";
const ROLE_FLAG = "sheltie-okf-role";
const OPEN_MARKER = "<sheltie-okf>";
const CLOSE_MARKER = "</sheltie-okf>";
const MAX_MARKER_CONTENT_CHARS = 16_384;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const OWNER_ONLY_MODE_MASK = 0o077;
const MAX_LOCK_ATTEMPTS = 20;
const LOCK_RETRY_DELAY_MS = 25;
const INVALID_MARKER_REASON = "okf_marker_invalid";
const PERSISTENCE_FAILURE_REASON = "okf_persistence_failed";
const MARKER_INSTRUCTION = [
  "Before automatic context compaction, preserve only durable, portable knowledge.",
  `Return it only inside ${OPEN_MARKER} and ${CLOSE_MARKER}.`,
  "Do not include transcripts, prompts, tool data, credentials, paths, or runtime or agent identifiers.",
  "Omit the marker when no safe durable knowledge remains.",
].join(" ");

interface ExtensionFlagOptions {
  type: "string";
  description?: string;
}

interface AutoCompactionStartEvent {
  type: "auto_compaction_start";
  action?: string;
}

interface SessionCompactingEvent {
  type: "session.compacting";
}

interface ProposedCompaction {
  summary?: unknown;
}

interface SessionCompactionPrecommitEvent {
  type: "session_compaction_precommit";
  reason?: unknown;
  timestamp: unknown;
  signal?: { aborted: boolean };
  compaction?: ProposedCompaction;
}


interface AutoCompactionEndEvent {
  type: "auto_compaction_end";
}

type ExtensionEvent =
  | AutoCompactionStartEvent
  | SessionCompactingEvent
  | SessionCompactionPrecommitEvent
  | AutoCompactionEndEvent;

type EventHandler = (event: unknown, context: unknown) => unknown | Promise<unknown>;

/** The small API surface this extension uses from the OMP extension host. */
interface OmpExtensionApi {
  registerFlag(name: string, options: ExtensionFlagOptions): void;
  getFlag(name: string): string | undefined;
  on(event: ExtensionEvent["type"], handler: EventHandler): void;
}

export interface OkfCompactionDurability {
  syncFile(file: FileHandle, path: string): Promise<void>;
  syncDirectory(directory: FileHandle, path: string): Promise<void>;
}

const DEFAULT_DURABILITY: OkfCompactionDurability = {
  syncFile(file) {
    return file.sync();
  },
  syncDirectory(directory) {
    return directory.sync();
  },
};


interface CompactionState {
  activeAutomaticContextFull: boolean;
  outputDirectory: string | undefined;
}

interface LockOwner {
  pid: number;
  processStartToken: string;
  ownerToken: string;
}

interface LockFileSnapshot {
  device: number;
  inode: number;
  owner: LockOwner | null;
}

function isEventOfType<T extends ExtensionEvent["type"]>(
  event: unknown,
  type: T,
): event is Extract<ExtensionEvent, { type: T }> {
  if (event === null || typeof event !== "object" || !("type" in event)) return false;
  return event.type === type;
}

type MarkerExtraction =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; content: string };

function extractMarkerContent(summary: string): MarkerExtraction {
  const openAt = summary.indexOf(OPEN_MARKER);
  const closeAt = summary.indexOf(CLOSE_MARKER, openAt + OPEN_MARKER.length);

  if (openAt < 0 && closeAt < 0) return { kind: "missing" };
  if (openAt < 0 || closeAt < 0) return { kind: "invalid" };
  if (summary.indexOf(OPEN_MARKER, openAt + OPEN_MARKER.length) >= 0) return { kind: "invalid" };
  if (summary.indexOf(CLOSE_MARKER) !== closeAt) return { kind: "invalid" };

  const content = summary.slice(openAt + OPEN_MARKER.length, closeAt).trim();
  if (content.length === 0 || content.length > MAX_MARKER_CONTENT_CHARS) return { kind: "invalid" };
  if (containsUnsafeContent(content)) return { kind: "invalid" };

  return { kind: "valid", content };
}

function containsUnsafeContent(content: string): boolean {
  const unsafePatterns = [
    /\[\[/,
    /\b(?:raw[_ -]?transcript|(?:system|user|assistant)[_ -]?prompt|tool[_ -]?(?:args?|arguments?|results?|output)|function[_ -]?(?:args?|result))\b/i,
    /(?:^|\n)\s*(?:user|assistant|system|tool)\s*:/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passphrase|authorization|credential(?:s)?|private[_-]?key)\b\s*(?:=|:)\s*["']?\S+/i,
    /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bfile:\/\//i,
    /(?:^|[\s("'`])\/(?:[^\s<>"'`\\]|\\.)+/m,
    /\b[A-Za-z]:[\\/]/,
    /\\\\[^\s]+/,
    /\b(?:agent|runtime|terminal|workspace|session|process|thread|container|pod|host|machine|node|run|request|task)(?:[ _-]?(?:id|identifier|instance|name))?\s*(?:=|:)\s*[^\s]+/i,
    /(?:^|[\s("'`])(?:\.\.?|~)[\\/](?:[^\s<>"'`\\]|\\.)+/m,
    /\b(?:ssh|sftp):\/\/[^\s<>"'`]+/i,
    /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s<>"'`]+/,
    /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i,
    /\b(?:agent|runtime|terminal|workspace|session|process|thread|container|pod|host|machine|node|run|request|task)[_-](?=[A-Za-z0-9_-]{8,}\b)[A-Za-z0-9_-]+\b/i,
    /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/,
  ];

  return unsafePatterns.some((pattern) => pattern.test(content));
}

function conceptDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function eventTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  return timestamp.toISOString();
}

function createConceptMarkdown(content: string, digest: string, timestamp: string): string {
  return [
    "---",
    "type: Compaction Knowledge",
    "title: Automatic compaction knowledge",
    "description: Portable continuity knowledge derived from an automatic compaction.",
    "status: draft",
    "tags: [sheltie, omp, compaction]",
    "generated:",
    "  by: sheltie-okf-compaction/0.1.0",
    `  at: ${timestamp}`,
    "sources:",
    "  - id: omp-auto-compaction",
    "    resource: omp:auto-compaction",
    "    title: OMP automatic compaction",
    `content_sha256: ${digest}`,
    "---",
    "",
    "# Automatic compaction knowledge",
    "",
    "This unverified draft was derived at the OMP automatic compaction boundary.[^omp-auto-compaction]",
    "",
    content,
    "",
    "[^omp-auto-compaction]: OMP automatic compaction",
    "",
  ].join("\n");
}

function createIndexMarkdown(): string {
  return [
    "---",
    'okf_version: "0.2"',
    "---",
    "",
    "# Automatic compaction knowledge",
    "",
    "Private, derived OKF concepts written during automatic context compaction.",
    "",
    "- [Content-addressed concepts](./concepts/) - Private draft concepts preserved at automatic compaction boundaries.",
    "",
  ].join("\n");
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

function currentEffectiveUid(): number {
  if (typeof process.geteuid !== "function") throw new Error("effective uid is unavailable");
  return process.geteuid();
}

function parseLinuxProcessStartToken(stat: string): string | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1) return null;
  const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const startToken = fieldsAfterCommand[19];
  return startToken !== undefined && /^\d+$/.test(startToken) ? startToken : null;
}

async function readProcessStartToken(pid: number): Promise<string | null | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return parseLinuxProcessStartToken(await readFile(`/proc/${pid}/stat`, "utf8")) ?? undefined;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    return undefined;
  }
}

function parseLockOwner(contents: string): LockOwner | null {
  try {
    const value = JSON.parse(contents) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "ownerToken,pid,processStartToken") return null;
    if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return null;
    if (typeof record.processStartToken !== "string" || !/^\d+$/.test(record.processStartToken)) return null;
    if (typeof record.ownerToken !== "string" || !/^[a-f0-9-]{36}$/.test(record.ownerToken)) return null;
    return {
      pid: record.pid,
      processStartToken: record.processStartToken,
      ownerToken: record.ownerToken,
    };
  } catch {
    return null;
  }
}

function sameLockOwner(left: LockOwner | null, right: LockOwner | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.pid === right.pid &&
    left.processStartToken === right.processStartToken &&
    left.ownerToken === right.ownerToken
  );
}

async function readPrivateLock(path: string): Promise<LockFileSnapshot | null> {
  let lock: FileHandle;
  try {
    lock = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    if (errnoCode(error) === "ELOOP") throw new Error("OKF output lock must not be a symbolic link");
    throw error;
  }
  try {
    const details = await lock.stat();
    if (!details.isFile()) throw new Error("OKF output lock is not a regular file");
    if (details.uid !== currentEffectiveUid()) {
      throw new Error("OKF output lock is not owned by the effective user");
    }
    if ((details.mode & OWNER_ONLY_MODE_MASK) !== 0) {
      throw new Error("OKF output lock is accessible to another user");
    }
    return {
      device: details.dev,
      inode: details.ino,
      owner: parseLockOwner(await lock.readFile("utf8")),
    };
  } finally {
    await lock.close();
  }
}

async function unlinkLockIfUnchanged(path: string, expected: LockFileSnapshot): Promise<boolean> {
  const current = await readPrivateLock(path);
  if (current === null) return true;
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    !sameLockOwner(current.owner, expected.owner)
  ) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true;
    throw error;
  }
}

async function createLockNoOverwrite(
  path: string,
  owner: LockOwner,
  durability: OkfCompactionDurability,
): Promise<LockFileSnapshot> {
  const temporaryPath = await writePrivateTemporaryFile(path, `${JSON.stringify(owner)}\n`, durability);
  let linked = false;
  try {
    await link(temporaryPath, path);
    linked = true;
    await syncPrivateDirectory(dirname(path), durability);
  } catch (error) {
    if (linked) {
      try {
        await unlink(path);
      } catch (cleanupError) {
        if (errnoCode(cleanupError) !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
  const created = await readPrivateLock(path);
  if (created === null || !sameLockOwner(created.owner, owner)) {
    throw new Error("OKF output lock identity changed during acquisition");
  }
  return created;
}

async function lockOwnerLiveness(owner: LockOwner): Promise<"live" | "stale" | "unknown"> {
  const currentStartToken = await readProcessStartToken(owner.pid);
  if (currentStartToken === undefined) return "unknown";
  if (currentStartToken === null || currentStartToken !== owner.processStartToken) return "stale";
  return "live";
}

function directoryPathChain(path: string): string[] {
  const paths: string[] = [];
  let current = resolve(path);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    paths.push(current);
    current = parent;
  }
  return paths.reverse();
}

async function openPrivateRegularFileNoFollow(path: string): Promise<FileHandle> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") throw new Error("OKF artifact must not be a symbolic link");
    throw error;
  }

  try {
    const details = await file.stat();
    if (!details.isFile()) throw new Error("OKF artifact is not a regular file");
    if (details.uid !== currentEffectiveUid()) {
      throw new Error("OKF artifact is not owned by the effective user");
    }
    if ((details.mode & OWNER_ONLY_MODE_MASK) !== 0) {
      throw new Error("OKF artifact is accessible to another user");
    }
    return file;
  } catch (error) {
    try {
      await file.close();
    } catch {
      // The validation error already fails closed.
    }
    throw error;
  }
}

async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  let directory: FileHandle;
  try {
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") throw new Error("OKF output directory must not be a symbolic link");
    throw error;
  }

  try {
    if (!(await directory.stat()).isDirectory()) {
      throw new Error("OKF output location is not a real directory");
    }
    return directory;
  } catch (error) {
    try {
      await directory.close();
    } catch {
      // The validation error already fails closed.
    }
    throw error;
  }
}

async function syncPrivateRegularFile(path: string, durability: OkfCompactionDurability): Promise<void> {
  const file = await openPrivateRegularFileNoFollow(path);
  try {
    await durability.syncFile(file, path);
  } finally {
    await file.close();
  }
}

async function syncPrivateDirectory(path: string, durability: OkfCompactionDurability): Promise<void> {
  const directory = await openDirectoryNoFollow(path);
  try {
    await durability.syncDirectory(directory, path);
  } finally {
    await directory.close();
  }
}

async function verifyAndSyncExistingArtifact(
  path: string,
  durability: OkfCompactionDurability,
  verify: (contents: Buffer) => void,
): Promise<void> {
  const file = await openPrivateRegularFileNoFollow(path);
  try {
    verify(await file.readFile());
    await durability.syncFile(file, path);
  } finally {
    await file.close();
  }
  await syncPrivateDirectory(dirname(path), durability);
}

async function ensurePrivateDirectory(
  path: string,
  durability: OkfCompactionDurability,
): Promise<string> {
  const resolvedPath = resolve(path);
  const missingDirectories: string[] = [];
  for (const candidate of directoryPathChain(resolvedPath)) {
    if ((await lstatIfPresent(candidate)) === null) missingDirectories.push(candidate);
  }
  await mkdir(resolvedPath, { recursive: true, mode: DIRECTORY_MODE });

  const details = await lstat(resolvedPath);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("OKF output location is not a real directory");
  }

  if (details.uid !== currentEffectiveUid()) {
    throw new Error("OKF output directory is not owned by the effective user");
  }

  await chmod(resolvedPath, DIRECTORY_MODE);
  const securedDetails = await lstat(resolvedPath);
  if ((securedDetails.mode & OWNER_ONLY_MODE_MASK) !== 0) {
    throw new Error("OKF output directory is accessible to another user");
  }

  if (missingDirectories.length > 0) {
    for (const createdDirectory of [...missingDirectories].reverse()) {
      await syncPrivateDirectory(createdDirectory, durability);
    }
    await syncPrivateDirectory(dirname(missingDirectories[0]!), durability);
  }

  return resolvedPath;
}

async function ensurePrivateRegularFile(path: string): Promise<boolean> {
  const details = await lstatIfPresent(path);
  if (details === null) return false;
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("OKF artifact is not a regular file");
  }
  if (details.uid !== currentEffectiveUid()) {
    throw new Error("OKF artifact is not owned by the effective user");
  }

  if ((details.mode & OWNER_ONLY_MODE_MASK) !== 0) {
    throw new Error("OKF artifact is accessible to another user");
  }

  return true;
}
async function acquireExclusiveLock(
  outputDirectory: string,
  durability: OkfCompactionDurability,
): Promise<() => Promise<void>> {
  const lockPath = join(outputDirectory, ".okf-compaction.lock");
  const processStartToken = await readProcessStartToken(process.pid);
  if (processStartToken === null || processStartToken === undefined) {
    throw new Error("current process start identity is unavailable");
  }
  const owner: LockOwner = {
    pid: process.pid,
    processStartToken,
    ownerToken: randomUUID(),
  };

  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const acquired = await createLockNoOverwrite(lockPath, owner, durability);
      return async () => {
        const current = await readPrivateLock(lockPath);
        if (current === null || !sameLockOwner(current.owner, owner)) return;
        await unlinkLockIfUnchanged(lockPath, acquired);
      };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      const existing = await readPrivateLock(lockPath);
      if (
        existing !== null &&
        existing.owner !== null &&
        (await lockOwnerLiveness(existing.owner)) === "stale" &&
        (await unlinkLockIfUnchanged(lockPath, existing))
      ) {
        continue;
      }
      if (attempt === MAX_LOCK_ATTEMPTS - 1) throw error;
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, LOCK_RETRY_DELAY_MS);
      await delay.promise;
    }
  }

  throw new Error("OKF output lock could not be acquired");
}


let temporaryFileSequence = 0;

async function writePrivateTemporaryFile(
  path: string,
  contents: string,
  durability: OkfCompactionDurability,
): Promise<string> {
  const directory = dirname(path);
  const baseName = basename(path);

  for (;;) {
    const temporaryPath = join(
      directory,
      `.${baseName}.tmp-${process.pid}-${randomUUID()}-${temporaryFileSequence++}`,
    );

    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    } catch (error) {
      if (errnoCode(error) === "EEXIST") continue;
      throw error;
    }

    try {
      await chmod(temporaryPath, FILE_MODE);
      await syncPrivateRegularFile(temporaryPath, durability);
      return temporaryPath;
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (errnoCode(cleanupError) !== "ENOENT") throw cleanupError;
      }
      throw error;
    }
  }
}

async function publishNoOverwrite(
  path: string,
  contents: string,
  durability: OkfCompactionDurability,
): Promise<void> {
  const temporaryPath = await writePrivateTemporaryFile(path, contents, durability);

  try {
    try {
      await link(temporaryPath, path);
      await ensurePrivateRegularFile(path);
      await syncPrivateDirectory(dirname(path), durability);
      return;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }

    if (!(await ensurePrivateRegularFile(path))) {
      throw new Error("OKF artifact disappeared while publishing");
    }

    await verifyAndSyncExistingArtifact(path, durability, (existingContents) => {
      if (!existingContents.equals(Buffer.from(contents, "utf8"))) {
        throw new Error("OKF artifact conflicts with an existing file");
      }
    });
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
}

async function publishConceptNoOverwrite(
  path: string,
  content: string,
  digest: string,
  timestamp: string,
  durability: OkfCompactionDurability,
): Promise<void> {
  if (!(await ensurePrivateRegularFile(path))) {
    await publishNoOverwrite(path, createConceptMarkdown(content, digest, timestamp), durability);
    return;
  }

  await verifyAndSyncExistingArtifact(path, durability, (existingContents) => {
    const existingMarkdown = existingContents.toString("utf8");
    const existingTimestamp = eventTimestamp(existingMarkdown.match(/^  at:\s*(.+)$/m)?.[1]);
    if (
      existingTimestamp === null ||
      !existingContents.equals(
        Buffer.from(createConceptMarkdown(content, digest, existingTimestamp), "utf8"),
      )
    ) {
      throw new Error("OKF artifact conflicts with an existing file");
    }
  });
}

async function persistConcept(
  outputDirectory: string,
  content: string,
  timestamp: string,
  signal: { aborted: boolean } | undefined,
  durability: OkfCompactionDurability,
): Promise<void> {
  if (signal?.aborted) throw new Error("OKF precommit was cancelled");

  const privateOutputDirectory = await ensurePrivateDirectory(outputDirectory, durability);
  const releaseLock = await acquireExclusiveLock(privateOutputDirectory, durability);

  try {
    if (signal?.aborted) throw new Error("OKF precommit was cancelled");

    const conceptsDirectory = await ensurePrivateDirectory(
      join(privateOutputDirectory, "concepts"),
      durability,
    );
    const digest = conceptDigest(content);
    const conceptName = `compaction-${digest}.md`;
    const conceptPath = join(conceptsDirectory, conceptName);

    await publishConceptNoOverwrite(conceptPath, content, digest, timestamp, durability);
    await publishNoOverwrite(join(privateOutputDirectory, "index.md"), createIndexMarkdown(), durability);
  } finally {
    await releaseLock();
  }
}

function safeLog(message: string): void {
  try {
    console.warn(`[sheltie-okf-compaction] ${message}`);
  } catch {
    // Logging cannot interfere with the host compaction lifecycle.
  }
}

export default async function okfCompactionExtension(
  api: OmpExtensionApi,
  durability: OkfCompactionDurability = DEFAULT_DURABILITY,
): Promise<void> {
  api.registerFlag(OUTPUT_DIRECTORY_FLAG, {
    type: "string",
    description: "Private directory for derived OKF compaction knowledge.",
  });
  api.registerFlag(ROLE_FLAG, {
    type: "string",
    description: "Manifest role authorized to write derived OKF compaction knowledge.",
  });

  const state: CompactionState = { activeAutomaticContextFull: false, outputDirectory: undefined };

  api.on("auto_compaction_start", (event) => {
    const outputDirectory = api.getFlag(OUTPUT_DIRECTORY_FLAG);
    const role = api.getFlag(ROLE_FLAG);
    const configured =
      typeof outputDirectory === "string" &&
      outputDirectory.length > 0 &&
      typeof role === "string" &&
      role.length > 0;
    state.activeAutomaticContextFull =
      configured &&
      isEventOfType(event, "auto_compaction_start") &&
      event.action === "context-full";
    state.outputDirectory = state.activeAutomaticContextFull ? outputDirectory : undefined;
  });

  api.on("session.compacting", (event) => {
    if (!state.activeAutomaticContextFull || !isEventOfType(event, "session.compacting")) return undefined;
    return { context: [MARKER_INSTRUCTION] };
  });

  api.on("session_compaction_precommit", async (event) => {
    if (
      !state.activeAutomaticContextFull ||
      state.outputDirectory === undefined ||
      !isEventOfType(event, "session_compaction_precommit")
    ) {
      return;
    }

    if (event.signal?.aborted) throw new Error(PERSISTENCE_FAILURE_REASON);

    const summary = event.compaction?.summary;
    const timestamp = eventTimestamp(event.timestamp);
    if (typeof summary !== "string" || timestamp === null) throw new Error(PERSISTENCE_FAILURE_REASON);

    const marker = extractMarkerContent(summary);
    if (marker.kind === "missing") return;
    if (marker.kind === "invalid") return { cancel: true, reason: INVALID_MARKER_REASON };

    try {
      await persistConcept(state.outputDirectory, marker.content, timestamp, event.signal, durability);
    } catch {
      safeLog("derived knowledge write failed");
      throw new Error(PERSISTENCE_FAILURE_REASON);
    }
  });


  api.on("auto_compaction_end", (event) => {
    if (!isEventOfType(event, "auto_compaction_end")) return;
    state.activeAutomaticContextFull = false;
    state.outputDirectory = undefined;
  });
}
