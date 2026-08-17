import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { requestHash } from "./ids.ts";
import { assertPrivateStateDirectory } from "./state-security.ts";
import { isRecord } from "./type-guards.ts";

export const RUNTIME_BUNDLE_API_VERSION = "sheltie.dev/runtime-bundle/v1alpha1";
export const LINUX_X64_RUNTIME_TARGET = "linux-x64" as const;
export const REQUIRED_V0_HERDR_SOURCE_COMMIT = "ea766d5a70d53ad66028d980fb43b5808947ea71";
export const REQUIRED_V0_OMP_SOURCE_COMMIT = "90fd6477137fc38c5257f11ad13d9b031b39c526";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_MODE_MASK = 0o077;
const GROUP_OR_OTHER_WRITABLE_MODE_MASK = 0o022;
const EXECUTABLE_MODE_MASK = 0o111;
const STICKY_DIRECTORY_MODE = 0o1000;
const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const RUNTIME_PATH_HASH_LENGTH = 24;
const SESSION_PATH_HASH_LENGTH = 16;
const ARTIFACT_BASENAMES = {
  sheltie: "sheltie",
  herdr: "herdr",
  omp: "omp",
  okfCompaction: "sheltie-okf-compaction.js",
} as const;

export type RuntimeBundleTarget = typeof LINUX_X64_RUNTIME_TARGET;

export interface RuntimeBundleManifestArtifact {
  path: string;
  sha256: string;
}

export interface RuntimeBundleManifestHerdrArtifact extends RuntimeBundleManifestArtifact {
  sourceCommit: string;
  version: string;
  protocol: number;
}

export interface RuntimeBundleManifestOmpArtifact extends RuntimeBundleManifestArtifact {
  sourceCommit: string;
  version: string;
}

export interface RuntimeBundleManifest {
  apiVersion: typeof RUNTIME_BUNDLE_API_VERSION;
  target: RuntimeBundleTarget;
  artifacts: {
    sheltie: RuntimeBundleManifestArtifact;
    herdr: RuntimeBundleManifestHerdrArtifact;
    omp: RuntimeBundleManifestOmpArtifact;
    okfCompaction: RuntimeBundleManifestArtifact;
  };
}

export interface RuntimeArtifactIdentity {
  path: string;
  sha256: string;
}

export interface HerdrRuntimeArtifactIdentity extends RuntimeArtifactIdentity {
  sourceCommit: string;
  version: string;
  protocol: number;
}

export interface OmpRuntimeArtifactIdentity extends RuntimeArtifactIdentity {
  sourceCommit: string;
  version: string;
}

export interface RuntimeBundle {
  root: string;
  digest: string;
  target: RuntimeBundleTarget;
  manifest: RuntimeBundleManifest;
  sheltie: RuntimeArtifactIdentity;
  herdr: HerdrRuntimeArtifactIdentity;
  omp: OmpRuntimeArtifactIdentity;
  okfCompaction: RuntimeArtifactIdentity;
}

export interface ExternalRuntimeBinding {
  mode: "external";
}

export interface BundledRuntimeBinding {
  mode: "bundled";
  bundleRoot: string;
  bundleDigest: string;
  bundleTarget: RuntimeBundleTarget;
  sessionName: string;
  configHome: string;
  socketPath: string;
  pathPrefix: string;
  sheltie: RuntimeArtifactIdentity;
  herdr: HerdrRuntimeArtifactIdentity;
  omp: OmpRuntimeArtifactIdentity;
  okfCompaction: RuntimeArtifactIdentity;
}

export type RuntimeBinding = ExternalRuntimeBinding | BundledRuntimeBinding;

export interface ResolveRuntimeBundleInput {
  sheltieExecutable: string;
  runtimeDir?: string;
}

function fail(message: string): never {
  throw new Error(`runtime bundle validation failed: ${message}`);
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const sha256 = requireString(value, label);
  if (!SHA256_PATTERN.test(sha256)) fail(`${label} must be a lowercase SHA-256 digest`);
  return sha256;
}

function requireSourceCommit(value: unknown, label: string): string {
  const sourceCommit = requireString(value, label);
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) fail(`${label} must be a full lowercase source commit SHA`);
  return sourceCommit;
}

function requireRequiredSourceCommit(value: unknown, label: string, required: string): string {
  const sourceCommit = requireSourceCommit(value, label);
  if (sourceCommit !== required) fail(`${label} must equal the required v0 source commit ${required}`);
  return sourceCommit;
}

function requireVersion(value: unknown, label: string): string {
  const version = requireString(value, label);
  if (version.length > 256 || /[\r\n\0]/.test(version)) fail(`${label} is invalid`);
  return version;
}

function requireProtocol(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} must be an absolute normalized path`);
  return path;
}

function requireSessionName(value: unknown): string {
  const sessionName = requireString(value, "sessionName");
  if (!/^(?:s-[a-f0-9]{16}|sheltie-[a-f0-9]{24})$/.test(sessionName)) fail("sessionName is invalid");
  return sessionName;
}

function assertSupportedRuntimePlatform(): void {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail(`target ${LINUX_X64_RUNTIME_TARGET} requires Linux x64, got ${process.platform}-${process.arch}`);
  }
}

function assertTrustedDirectory(path: string, label: string): void {
  const details = lstatIfPresent(path);
  if (details === null) fail(`${label} is missing: ${path}`);
  if (details.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${path}`);
  if (!details.isDirectory()) fail(`${label} must be a directory: ${path}`);
  if (details.uid !== effectiveUid() && details.uid !== 0) {
    fail(`${label} is not owned by the effective uid or root: ${path}`);
  }
  if ((details.mode & GROUP_OR_OTHER_WRITABLE_MODE_MASK) !== 0) {
    fail(`${label} grants group or other write access: ${path}`);
  }
}

function assertTrustedBundleAncestors(root: string): void {
  const uid = effectiveUid();
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    const details = lstatIfPresent(ancestor);
    if (details === null) fail(`runtime bundle ancestor is missing: ${ancestor}`);
    if (details.isSymbolicLink()) fail(`runtime bundle ancestor must not be a symbolic link: ${ancestor}`);
    if (!details.isDirectory()) fail(`runtime bundle ancestor must be a directory: ${ancestor}`);
    if (details.uid !== uid && details.uid !== 0) {
      fail(`runtime bundle ancestor is not owned by the effective uid or root: ${ancestor}`);
    }
    if (
      (details.mode & GROUP_OR_OTHER_WRITABLE_MODE_MASK) !== 0 &&
      (details.mode & STICKY_DIRECTORY_MODE) === 0
    ) {
      fail(`runtime bundle ancestor grants group or other write access without the sticky bit: ${ancestor}`);
    }
    if (ancestor === dirname(ancestor)) return;
  }
}

function assertTrustedArtifactDetails(details: Stats, path: string, executable: boolean): void {
  if (!details.isFile()) fail(`artifact must be a regular file: ${path}`);
  if (details.uid !== effectiveUid() && details.uid !== 0) {
    fail(`artifact is not owned by the effective uid or root: ${path}`);
  }
  if ((details.mode & GROUP_OR_OTHER_WRITABLE_MODE_MASK) !== 0) {
    fail(`artifact grants group or other write access: ${path}`);
  }
  if (executable && (details.mode & EXECUTABLE_MODE_MASK) === 0) {
    fail(`runtime executable is not executable: ${path}`);
  }
}

function readTrustedFile(path: string, label: string, executable = false): Buffer {
  assertTrustedDirectory(dirname(path), `${label} parent`);
  const initial = lstatIfPresent(path);
  if (initial === null) fail(`${label} is missing: ${path}`);
  if (initial.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${path}`);

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") fail(`${label} must not be a symbolic link: ${path}`);
    throw error;
  }
  try {
    assertTrustedArtifactDetails(fstatSync(descriptor), path, executable);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseRelativeArtifact(
  value: unknown,
  label: string,
  expectedBasename: string,
): RuntimeBundleManifestArtifact {
  const artifact = requireRecord(value, label);
  requireExactKeys(artifact, ["path", "sha256"], label);
  const path = requireString(artifact.path, `${label}.path`);
  if (path !== expectedBasename || basename(path) !== path || path.includes("/") || path.includes("\\")) {
    fail(`${label}.path must be the relative basename ${expectedBasename}`);
  }
  return { path, sha256: requireSha256(artifact.sha256, `${label}.sha256`) };
}

function parseHerdrArtifact(value: unknown): RuntimeBundleManifestHerdrArtifact {
  const artifact = requireRecord(value, "artifacts.herdr");
  requireExactKeys(artifact, ["path", "sha256", "sourceCommit", "version", "protocol"], "artifacts.herdr");
  return {
    ...parseRelativeArtifact({ path: artifact.path, sha256: artifact.sha256 }, "artifacts.herdr", ARTIFACT_BASENAMES.herdr),
    sourceCommit: requireRequiredSourceCommit(
      artifact.sourceCommit,
      "artifacts.herdr.sourceCommit",
      REQUIRED_V0_HERDR_SOURCE_COMMIT,
    ),
    version: requireVersion(artifact.version, "artifacts.herdr.version"),
    protocol: requireProtocol(artifact.protocol, "artifacts.herdr.protocol"),
  };
}

function parseOmpArtifact(value: unknown): RuntimeBundleManifestOmpArtifact {
  const artifact = requireRecord(value, "artifacts.omp");
  requireExactKeys(artifact, ["path", "sha256", "sourceCommit", "version"], "artifacts.omp");
  return {
    ...parseRelativeArtifact({ path: artifact.path, sha256: artifact.sha256 }, "artifacts.omp", ARTIFACT_BASENAMES.omp),
    sourceCommit: requireRequiredSourceCommit(
      artifact.sourceCommit,
      "artifacts.omp.sourceCommit",
      REQUIRED_V0_OMP_SOURCE_COMMIT,
    ),
    version: requireVersion(artifact.version, "artifacts.omp.version"),
  };
}

function parseRuntimeBundleManifest(value: unknown): RuntimeBundleManifest {
  const manifest = requireRecord(value, "runtime manifest");
  requireExactKeys(manifest, ["apiVersion", "target", "artifacts"], "runtime manifest");
  if (manifest.apiVersion !== RUNTIME_BUNDLE_API_VERSION) {
    fail(`unsupported apiVersion ${String(manifest.apiVersion)}`);
  }
  if (manifest.target !== LINUX_X64_RUNTIME_TARGET) fail(`unsupported target ${String(manifest.target)}`);
  const artifacts = requireRecord(manifest.artifacts, "runtime manifest artifacts");
  requireExactKeys(artifacts, ["sheltie", "herdr", "omp", "okfCompaction"], "runtime manifest artifacts");
  return {
    apiVersion: RUNTIME_BUNDLE_API_VERSION,
    target: LINUX_X64_RUNTIME_TARGET,
    artifacts: {
      sheltie: parseRelativeArtifact(artifacts.sheltie, "artifacts.sheltie", ARTIFACT_BASENAMES.sheltie),
      herdr: parseHerdrArtifact(artifacts.herdr),
      omp: parseOmpArtifact(artifacts.omp),
      okfCompaction: parseRelativeArtifact(
        artifacts.okfCompaction,
        "artifacts.okfCompaction",
        ARTIFACT_BASENAMES.okfCompaction,
      ),
    },
  };
}

function parseManifestBytes(bytes: Buffer): RuntimeBundleManifest {
  try {
    return parseRuntimeBundleManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("runtime bundle validation failed:")) throw error;
    fail(`runtime-manifest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyArtifact(
  bundleRoot: string,
  artifact: RuntimeBundleManifestArtifact,
  label: string,
  executable: boolean,
): RuntimeArtifactIdentity {
  const path = join(bundleRoot, artifact.path);
  const bytes = readTrustedFile(path, label, executable);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== artifact.sha256) {
    fail(`${label} SHA-256 mismatch: expected ${artifact.sha256}, got ${actualSha256}`);
  }
  return { path, sha256: actualSha256 };
}

function assertUnixSocketPathLength(path: string): void {
  const byteLength = Buffer.byteLength(path, "utf8");
  if (byteLength > UNIX_SOCKET_PATH_MAX_BYTES) {
    fail(`socketPath is ${byteLength} UTF-8 bytes; must not exceed ${UNIX_SOCKET_PATH_MAX_BYTES}`);
  }
}

function ensurePrivateDirectory(path: string, label: string): void {
  if (lstatIfPresent(path) === null) {
    try {
      mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const details = lstatIfPresent(path);
  if (details === null) fail(`${label} is missing`);
  if (details.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${path}`);
  if (!details.isDirectory()) fail(`${label} must be a directory: ${path}`);
  if (details.uid !== effectiveUid()) fail(`${label} is not owned by the effective uid: ${path}`);
  if ((details.mode & OWNER_ONLY_MODE_MASK) !== 0) fail(`${label} grants group or other access: ${path}`);
}

function requireBindingArtifact(value: unknown, label: string, expectedPath: string): RuntimeArtifactIdentity {
  const artifact = requireRecord(value, label);
  requireExactKeys(artifact, ["path", "sha256"], label);
  const path = requireAbsolutePath(artifact.path, `${label}.path`);
  if (path !== expectedPath) fail(`${label}.path does not match bundle identity`);
  return { path, sha256: requireSha256(artifact.sha256, `${label}.sha256`) };
}

function requireBindingHerdr(value: unknown, expectedPath: string): HerdrRuntimeArtifactIdentity {
  const artifact = requireRecord(value, "herdr");
  requireExactKeys(artifact, ["path", "sha256", "sourceCommit", "version", "protocol"], "herdr");
  return {
    ...requireBindingArtifact({ path: artifact.path, sha256: artifact.sha256 }, "herdr", expectedPath),
    sourceCommit: requireRequiredSourceCommit(
      artifact.sourceCommit,
      "herdr.sourceCommit",
      REQUIRED_V0_HERDR_SOURCE_COMMIT,
    ),
    version: requireVersion(artifact.version, "herdr.version"),
    protocol: requireProtocol(artifact.protocol, "herdr.protocol"),
  };
}

function requireBindingOmp(value: unknown, expectedPath: string): OmpRuntimeArtifactIdentity {
  const artifact = requireRecord(value, "omp");
  requireExactKeys(artifact, ["path", "sha256", "sourceCommit", "version"], "omp");
  return {
    ...requireBindingArtifact({ path: artifact.path, sha256: artifact.sha256 }, "omp", expectedPath),
    sourceCommit: requireRequiredSourceCommit(
      artifact.sourceCommit,
      "omp.sourceCommit",
      REQUIRED_V0_OMP_SOURCE_COMMIT,
    ),
    version: requireVersion(artifact.version, "omp.version"),
  };
}

export function parseRuntimeBinding(value: unknown): RuntimeBinding {
  const binding = requireRecord(value, "runtime binding");
  const mode = binding.mode;
  if (mode === "external") {
    requireExactKeys(binding, ["mode"], "external runtime binding");
    return { mode: "external" };
  }
  if (mode !== "bundled") fail("runtime binding mode must be external or bundled");
  requireExactKeys(
    binding,
    [
      "mode",
      "bundleRoot",
      "bundleDigest",
      "bundleTarget",
      "sessionName",
      "configHome",
      "socketPath",
      "pathPrefix",
      "sheltie",
      "herdr",
      "omp",
      "okfCompaction",
    ],
    "bundled runtime binding",
  );
  const bundleRoot = requireAbsolutePath(binding.bundleRoot, "bundleRoot");
  const bundleDigest = requireSha256(binding.bundleDigest, "bundleDigest");
  if (binding.bundleTarget !== LINUX_X64_RUNTIME_TARGET) fail(`unsupported bundleTarget ${String(binding.bundleTarget)}`);
  const configHome = requireAbsolutePath(binding.configHome, "configHome");
  const sessionName = requireSessionName(binding.sessionName);
  const socketPath = requireAbsolutePath(binding.socketPath, "socketPath");
  const pathPrefix = requireAbsolutePath(binding.pathPrefix, "pathPrefix");
  if (pathPrefix !== bundleRoot) fail("pathPrefix must equal bundleRoot");
  if (socketPath !== join(configHome, "herdr", "sessions", sessionName, "herdr.sock")) {
    fail("socketPath does not match the named-session config path");
  }
  return {
    mode: "bundled",
    bundleRoot,
    bundleDigest,
    bundleTarget: LINUX_X64_RUNTIME_TARGET,
    sessionName,
    configHome,
    socketPath,
    pathPrefix,
    sheltie: requireBindingArtifact(binding.sheltie, "sheltie", join(bundleRoot, ARTIFACT_BASENAMES.sheltie)),
    herdr: requireBindingHerdr(binding.herdr, join(bundleRoot, ARTIFACT_BASENAMES.herdr)),
    omp: requireBindingOmp(binding.omp, join(bundleRoot, ARTIFACT_BASENAMES.omp)),
    okfCompaction: requireBindingArtifact(
      binding.okfCompaction,
      "okfCompaction",
      join(bundleRoot, ARTIFACT_BASENAMES.okfCompaction),
    ),
  };
}

/** Resolves and validates the complete, non-relocatable identity of a v0 runtime bundle. */
export function resolveRuntimeBundle(input: ResolveRuntimeBundleInput): RuntimeBundle {
  assertSupportedRuntimePlatform();
  const sheltieExecutable = requireString(input.sheltieExecutable, "sheltieExecutable");
  const root = realpathSync(resolve(input.runtimeDir ?? dirname(resolve(sheltieExecutable))));
  assertTrustedDirectory(root, "runtime bundle root");
  assertTrustedBundleAncestors(root);
  const manifestBytes = readTrustedFile(join(root, "runtime-manifest.json"), "runtime manifest");
  const manifest = parseManifestBytes(manifestBytes);
  const sheltie = verifyArtifact(root, manifest.artifacts.sheltie, "Sheltie runtime", true);
  const herdrArtifact = verifyArtifact(root, manifest.artifacts.herdr, "Herdr runtime", true);
  const ompArtifact = verifyArtifact(root, manifest.artifacts.omp, "OMP runtime", true);
  const okfCompaction = verifyArtifact(root, manifest.artifacts.okfCompaction, "OKF compaction extension", false);
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  return {
    root,
    digest,
    target: manifest.target,
    manifest,
    sheltie,
    herdr: {
      ...herdrArtifact,
      sourceCommit: manifest.artifacts.herdr.sourceCommit,
      version: manifest.artifacts.herdr.version,
      protocol: manifest.artifacts.herdr.protocol,
    },
    omp: {
      ...ompArtifact,
      sourceCommit: manifest.artifacts.omp.sourceCommit,
      version: manifest.artifacts.omp.version,
    },
    okfCompaction,
  };
}

function assertRuntimeArtifactMatches(
  current: RuntimeArtifactIdentity,
  persisted: RuntimeArtifactIdentity,
  label: string,
): void {
  if (current.path !== persisted.path || current.sha256 !== persisted.sha256) {
    fail(`current ${label} artifact does not match the persisted bundled runtime binding`);
  }
}

/**
 * Revalidates bundle provenance without re-deriving the binding's persisted
 * session, configuration home, or socket paths from ambient process state.
 */
export function assertRuntimeBundleMatchesBinding(
  bundle: RuntimeBundle,
  binding: BundledRuntimeBinding,
): void {
  const persisted = parseRuntimeBinding(binding);
  if (persisted.mode !== "bundled") fail("a bundled runtime binding is required");
  if (
    bundle.root !== persisted.bundleRoot ||
    bundle.digest !== persisted.bundleDigest ||
    bundle.target !== persisted.bundleTarget
  ) {
    fail("current bundle root, digest, or target does not match the persisted bundled runtime binding");
  }
  assertRuntimeArtifactMatches(bundle.sheltie, persisted.sheltie, "Sheltie");
  assertRuntimeArtifactMatches(bundle.herdr, persisted.herdr, "Herdr");
  if (
    bundle.herdr.sourceCommit !== persisted.herdr.sourceCommit ||
    bundle.herdr.version !== persisted.herdr.version ||
    bundle.herdr.protocol !== persisted.herdr.protocol
  ) {
    fail("current Herdr provenance does not match the persisted bundled runtime binding");
  }
  assertRuntimeArtifactMatches(bundle.omp, persisted.omp, "OMP");
  if (
    bundle.omp.sourceCommit !== persisted.omp.sourceCommit ||
    bundle.omp.version !== persisted.omp.version
  ) {
    fail("current OMP provenance does not match the persisted bundled runtime binding");
  }
  assertRuntimeArtifactMatches(bundle.okfCompaction, persisted.okfCompaction, "OKF compaction");
}

/**
 * Creates the only bundled binding shape. Its Herdr state uses an owner-private
 * short runtime root so arbitrary state paths cannot exhaust Unix socket space.
 */
export function createBundledRuntimeBinding(
  bundle: RuntimeBundle,
  statePath: string,
  runId: string,
): BundledRuntimeBinding {
  assertSupportedRuntimePlatform();
  if (bundle.target !== LINUX_X64_RUNTIME_TARGET) fail(`unsupported bundle target ${bundle.target}`);
  const parsedRunId = requireString(runId, "runId").trim();
  if (parsedRunId.length === 0 || parsedRunId.length > 128) fail("runId must contain 1-128 characters");
  const stateRoot = assertPrivateStateDirectory(resolve(requireString(statePath, "statePath")), "runtime state root");
  const runHash = requestHash({ stateRoot, bundleDigest: bundle.digest, runId: parsedRunId }).slice(0, RUNTIME_PATH_HASH_LENGTH);
  const runtimeRoot = join(resolve(tmpdir()), `sheltie-herdr-${effectiveUid()}`);
  const configHome = join(runtimeRoot, runHash);
  const sessionName = `s-${runHash.slice(0, SESSION_PATH_HASH_LENGTH)}`;
  const socketPath = join(configHome, "herdr", "sessions", sessionName, "herdr.sock");
  assertUnixSocketPathLength(socketPath);
  for (const [path, label] of [
    [runtimeRoot, "shared Herdr runtime directory"],
    [configHome, "run-owned Herdr config directory"],
    [join(configHome, "herdr"), "Herdr config directory"],
    [join(configHome, "herdr", "sessions"), "Herdr sessions directory"],
    [join(configHome, "herdr", "sessions", sessionName), "named Herdr session directory"],
  ] as const) {
    ensurePrivateDirectory(path, label);
  }
  return {
    mode: "bundled",
    bundleRoot: bundle.root,
    bundleDigest: bundle.digest,
    bundleTarget: bundle.target,
    sessionName,
    configHome,
    socketPath,
    pathPrefix: bundle.root,
    sheltie: { ...bundle.sheltie },
    herdr: { ...bundle.herdr },
    omp: { ...bundle.omp },
    okfCompaction: { ...bundle.okfCompaction },
  };
}
