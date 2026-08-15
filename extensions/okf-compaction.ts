import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
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

interface SessionCompactEvent {
  type: "session_compact";
  fromExtension?: boolean;
  compactionEntry?: {
    summary?: unknown;
    timestamp?: unknown;
  };
}

interface AutoCompactionEndEvent {
  type: "auto_compaction_end";
}

type ExtensionEvent =
  | AutoCompactionStartEvent
  | SessionCompactingEvent
  | SessionCompactEvent
  | AutoCompactionEndEvent;

type EventHandler = (event: unknown, context: unknown) => unknown | Promise<unknown>;

/** The small API surface this extension uses from the OMP extension host. */
interface OmpExtensionApi {
  registerFlag(name: string, options: ExtensionFlagOptions): void;
  getFlag(name: string): string | undefined;
  on(event: ExtensionEvent["type"], handler: EventHandler): void;
}

interface CompactionState {
  activeAutomaticContextFull: boolean;
  outputDirectory: string | undefined;
}

function isEventOfType<T extends ExtensionEvent["type"]>(
  event: unknown,
  type: T,
): event is Extract<ExtensionEvent, { type: T }> {
  if (event === null || typeof event !== "object" || !("type" in event)) return false;
  return event.type === type;
}

function extractMarkerContent(summary: string): string | null {
  const openAt = summary.indexOf(OPEN_MARKER);
  const closeAt = summary.indexOf(CLOSE_MARKER, openAt + OPEN_MARKER.length);

  if (openAt < 0 || closeAt < 0) return null;
  if (summary.indexOf(OPEN_MARKER, openAt + OPEN_MARKER.length) >= 0) return null;
  if (summary.indexOf(CLOSE_MARKER) !== closeAt) return null;

  const content = summary.slice(openAt + OPEN_MARKER.length, closeAt).trim();
  if (content.length === 0 || content.length > MAX_MARKER_CONTENT_CHARS) return null;
  if (containsUnsafeContent(content)) return null;

  return content;
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

async function ensurePrivateDirectory(path: string): Promise<string> {
  const resolvedPath = resolve(path);
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

let temporaryFileSequence = 0;

async function writePrivateTemporaryFile(path: string, contents: string): Promise<string> {
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

async function publishNoOverwrite(path: string, contents: string): Promise<void> {
  const temporaryPath = await writePrivateTemporaryFile(path, contents);

  try {
    try {
      await link(temporaryPath, path);
      await ensurePrivateRegularFile(path);
      return;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }

    if (!(await ensurePrivateRegularFile(path))) {
      throw new Error("OKF artifact disappeared while publishing");
    }

    const existingContents = await readFile(path);
    if (!existingContents.equals(Buffer.from(contents, "utf8"))) {
      throw new Error("OKF artifact conflicts with an existing file");
    }
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
}

async function persistConcept(outputDirectory: string, content: string, timestamp: string): Promise<void> {
  const privateOutputDirectory = await ensurePrivateDirectory(outputDirectory);
  const conceptsDirectory = await ensurePrivateDirectory(join(privateOutputDirectory, "concepts"));
  const digest = conceptDigest(content);
  const conceptName = `compaction-${digest}.md`;
  const conceptPath = join(conceptsDirectory, conceptName);

  await publishNoOverwrite(conceptPath, createConceptMarkdown(content, digest, timestamp));
  await publishNoOverwrite(join(privateOutputDirectory, "index.md"), createIndexMarkdown());
}

function safeLog(message: string): void {
  try {
    console.warn(`[sheltie-okf-compaction] ${message}`);
  } catch {
    // Logging cannot interfere with the host compaction lifecycle.
  }
}

export default async function okfCompactionExtension(api: OmpExtensionApi): Promise<void> {
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

  api.on("session_compact", async (event) => {
    if (
      !state.activeAutomaticContextFull ||
      state.outputDirectory === undefined ||
      !isEventOfType(event, "session_compact") ||
      event.fromExtension === true
    ) {
      return;
    }

    const summary = event.compactionEntry?.summary;
    const timestamp = eventTimestamp(event.compactionEntry?.timestamp);
    if (typeof summary !== "string" || timestamp === null) return;

    const content = extractMarkerContent(summary);
    if (content === null) return;

    try {
      await persistConcept(state.outputDirectory, content, timestamp);
    } catch {
      safeLog("derived knowledge write skipped");
    }
  });

  api.on("auto_compaction_end", (event) => {
    if (!isEventOfType(event, "auto_compaction_end")) return;
    state.activeAutomaticContextFull = false;
    state.outputDirectory = undefined;
  });
}
