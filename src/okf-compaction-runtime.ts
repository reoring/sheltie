import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { requestHash } from "./ids.ts";
import { assertPrivateStateDirectory } from "./state-security.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OWNER_ONLY_MODE_MASK = 0o077;
const GROUP_OR_OTHER_WRITABLE_MODE_MASK = 0o022;
const OKF_COMPACTION_EXTENSION_BASENAME = "sheltie-okf-compaction.js";

export interface OkfCompactionRuntime {
  extensionPath: string;
  configPath: string;
  outputDirectory: string;
}

export interface PrepareOkfCompactionRuntimeInput {
  stateDatabasePath: string;
  treeId: string;
  nodeId: string;
  thresholdPercent: number;
  extensionPath: string;
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
  if (typeof process.geteuid !== "function") {
    throw new Error("OKF compaction runtime requires an effective uid");
  }
  return process.geteuid();
}


function ensureOwnerPrivateDirectory(path: string, label: string): void {
  if (lstatIfPresent(path) === null) mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const details = lstatIfPresent(path);
  if (details === null) throw new Error(`${label} is missing`);
  if (details.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!details.isDirectory()) throw new Error(`${label} must be a directory`);
  if (details.uid !== effectiveUid()) throw new Error(`${label} is not owned by the effective uid`);
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function assertTrustedExtensionParent(path: string): void {
  const details = lstatIfPresent(path);
  if (details === null) throw new Error(`OKF compaction extension parent is missing: ${path}`);
  if (details.isSymbolicLink()) throw new Error(`OKF compaction extension parent must not be a symbolic link: ${path}`);
  if (!details.isDirectory()) throw new Error(`OKF compaction extension parent must be a directory: ${path}`);
  if ((details.mode & GROUP_OR_OTHER_WRITABLE_MODE_MASK) !== 0) {
    throw new Error(`OKF compaction extension parent grants group or other write access: ${path}`);
  }
}

function assertTrustedExtensionDetails(details: Stats, path: string): void {
  if (!details.isFile()) throw new Error(`OKF compaction extension must be a regular file: ${path}`);
  if (details.uid !== effectiveUid() && details.uid !== 0) {
    throw new Error(`OKF compaction extension is not owned by the effective uid or root: ${path}`);
  }
  if ((details.mode & GROUP_OR_OTHER_WRITABLE_MODE_MASK) !== 0) {
    throw new Error(`OKF compaction extension grants group or other write access: ${path}`);
  }
}

function readTrustedExtensionBytes(path: string): Buffer {
  assertTrustedExtensionParent(dirname(path));
  const initial = lstatIfPresent(path);
  if (initial === null) throw new Error(`OKF compaction extension is missing: ${path}`);
  if (initial.isSymbolicLink()) throw new Error(`OKF compaction extension must not be a symbolic link: ${path}`);

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`OKF compaction extension must not be a symbolic link: ${path}`);
    }
    throw error;
  }
  try {
    assertTrustedExtensionDetails(fstatSync(descriptor), path);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function configOverlay(thresholdPercent: number): string {
  return [
    "compaction:",
    "  enabled: true",
    "  strategy: context-full",
    "  remoteEnabled: false",
    `  thresholdPercent: ${thresholdPercent}`,
    "  thresholdTokens: -1",
    "  autoContinue: true",
    "",
  ].join("\n");
}

type PrivateFileContent = string | Uint8Array;

function isCurrentOwnerPrivateFile(path: string, expected: PrivateFileContent, label: string): boolean {
  const details = lstatIfPresent(path);
  if (details === null) return false;
  if (details.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!details.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  if (details.uid !== effectiveUid()) throw new Error(`${label} is not owned by the effective uid: ${path}`);
  if ((details.mode & OWNER_ONLY_MODE_MASK) !== 0) return false;
  const actual = readFileSync(path);
  return typeof expected === "string" ? actual.toString("utf8") === expected : actual.equals(expected);
}

function writeOwnerPrivateFileAtomically(path: string, content: PrivateFileContent, label: string): void {
  if (isCurrentOwnerPrivateFile(path, content, label)) return;

  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, content, { mode: PRIVATE_FILE_MODE, flag: "wx" });
    chmodSync(temporaryPath, PRIVATE_FILE_MODE);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

export function defaultOkfCompactionExtensionPath(sheltieExecutable: string): string {
  return join(dirname(resolve(sheltieExecutable)), OKF_COMPACTION_EXTENSION_BASENAME);
}

export function prepareOkfCompactionRuntime(input: PrepareOkfCompactionRuntimeInput): OkfCompactionRuntime {
  const stateRoot = assertPrivateStateDirectory(dirname(resolve(input.stateDatabasePath)), "OKF compaction state root");
  const extensionBytes = readTrustedExtensionBytes(resolve(input.extensionPath));

  const runtimeDirectory = join(stateRoot, "runtime");
  const configDirectory = join(runtimeDirectory, "okf-compaction");
  const extensionsDirectory = join(configDirectory, "extensions");
  const knowledgeDirectory = join(stateRoot, "knowledge");
  const nodeHash = requestHash({ treeId: input.treeId, nodeId: input.nodeId }).slice(0, 16);
  const outputDirectory = join(knowledgeDirectory, nodeHash);
  ensureOwnerPrivateDirectory(runtimeDirectory, "OKF compaction runtime directory");
  ensureOwnerPrivateDirectory(configDirectory, "OKF compaction config directory");
  ensureOwnerPrivateDirectory(extensionsDirectory, "OKF compaction extensions directory");
  ensureOwnerPrivateDirectory(knowledgeDirectory, "OKF compaction knowledge directory");
  ensureOwnerPrivateDirectory(outputDirectory, "OKF compaction output directory");

  const extensionHash = createHash("sha256").update(extensionBytes).digest("hex");
  const extensionPath = join(extensionsDirectory, `${OKF_COMPACTION_EXTENSION_BASENAME.slice(0, -3)}-${extensionHash}.js`);
  writeOwnerPrivateFileAtomically(extensionPath, extensionBytes, "OKF compaction staged extension");

  const configPath = join(configDirectory, `${nodeHash}.yml`);
  writeOwnerPrivateFileAtomically(configPath, configOverlay(input.thresholdPercent), "OKF compaction config");
  return { extensionPath, configPath, outputDirectory };
}
