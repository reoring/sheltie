import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LINUX_X64_RUNTIME_TARGET,
  REQUIRED_V0_HERDR_SOURCE_COMMIT,
  REQUIRED_V0_OMP_SOURCE_COMMIT,
  RUNTIME_BUNDLE_API_VERSION,
  type RuntimeBundleManifest,
} from "../src/runtime-bundle.ts";

const RUNTIME_BUILD_INFO_SCHEMA = "sheltie.runtime-build-info/v1";
const HERDR_VERSION = "0.8.0";
const HERDR_PROTOCOL = 20;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GROUP_OR_OTHER_WRITABLE_MODE_MASK = 0o022;
const STICKY_DIRECTORY_MODE = 0o1000;
const BUILD_INFO_PROBE_TIMEOUT_MS = 5_000;
const BUILD_INFO_PROBE_TERMINATION_GRACE_MS = 1_000;

export interface BuildRuntimeBundleInput {
  herdrBin: string;
  ompBin: string;
  output?: string;
  sheltiePath?: string;
  okfCompactionPath?: string;
}

export interface BuiltRuntimeBundle {
  root: string;
  digest: string;
  manifest: RuntimeBundleManifest;
}

export interface RuntimeBuildInfoProbeProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export interface RuntimeBundleBuilderDependencies {
  spawnBuildInfoProbe?: (binaryPath: string) => RuntimeBuildInfoProbeProcess;
  buildInfoProbeTimeoutMs?: number;
  buildInfoProbeTerminationGraceMs?: number;
}

interface ExpectedBuildInfo {
  name: "herdr" | "omp";
  sourceCommit: string;
  version?: string;
  protocol?: number;
}

interface RuntimeBuildInfo {
  sourceCommit: string;
  version: string;
  protocol?: number;
}

function buildFailure(message: string): never {
  throw new Error(`runtime bundle build failed: ${message}`);
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertInputArtifact(path: string, label: string, executable: boolean): string {
  const resolvedPath = resolve(path);
  const details = lstatIfPresent(resolvedPath);
  if (details === null) buildFailure(`${label} is missing: ${resolvedPath}`);
  if (details.isSymbolicLink()) buildFailure(`${label} must not be a symbolic link: ${resolvedPath}`);
  if (!details.isFile()) buildFailure(`${label} must be a regular file: ${resolvedPath}`);
  if ((details.mode & GROUP_OR_OTHER_WRITABLE_MODE_MASK) !== 0) {
    buildFailure(`${label} grants group or other write access: ${resolvedPath}`);
  }
  if (executable && (details.mode & 0o111) === 0) buildFailure(`${label} must be executable: ${resolvedPath}`);
  return resolvedPath;
}

function assertTrustedOutputParent(outputParent: string): void {
  if (typeof process.geteuid !== "function") buildFailure("effective uid is unavailable");
  const uid = process.geteuid();
  for (let ancestor = outputParent; ; ancestor = dirname(ancestor)) {
    const details = lstatIfPresent(ancestor);
    if (details === null) buildFailure(`output directory ancestor is missing: ${ancestor}`);
    if (details.isSymbolicLink()) buildFailure(`output directory ancestor must not be a symbolic link: ${ancestor}`);
    if (!details.isDirectory()) buildFailure(`output directory ancestor must be a directory: ${ancestor}`);
    if (details.uid !== uid && details.uid !== 0) {
      buildFailure(`output directory ancestor is not owned by the effective uid or root: ${ancestor}`);
    }
    if (ancestor === outputParent) {
      if ((details.mode & GROUP_OR_OTHER_WRITABLE_MODE_MASK) !== 0) {
        buildFailure(`output directory grants group or other write access: ${ancestor}`);
      }
    } else if (
      (details.mode & GROUP_OR_OTHER_WRITABLE_MODE_MASK) !== 0 &&
      (details.mode & STICKY_DIRECTORY_MODE) === 0
    ) {
      buildFailure(`output directory ancestor grants group or other write access without the sticky bit: ${ancestor}`);
    }
    if (ancestor === dirname(ancestor)) return;
  }
}


function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function defaultSpawnBuildInfoProbe(binaryPath: string): RuntimeBuildInfoProbeProcess {
  const child = Bun.spawn([binaryPath, "--build-info"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

async function waitForBuildInfoProbeExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
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

async function terminateBuildInfoProbe(
  process: RuntimeBuildInfoProbeProcess,
  exited: Promise<number>,
  terminationGraceMs: number,
): Promise<void> {
  process.kill("SIGTERM");
  if (await waitForBuildInfoProbeExit(exited, terminationGraceMs)) return;
  process.kill("SIGKILL");
  await exited;
}

function parseBuildInfoJsonl(
  stdout: string,
  stderr: string,
  label: string,
  expected: ExpectedBuildInfo,
): RuntimeBuildInfo {
  if (stderr.length > 0) buildFailure(`${label} --build-info must not write to stderr`);
  if (!stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1) {
    buildFailure(`${label} --build-info must write exactly one JSONL record`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(0, -1));
  } catch {
    buildFailure(`${label} --build-info must contain valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    buildFailure(`${label} --build-info must contain an object record`);
  }

  const record = parsed as Record<string, unknown>;
  const expectedKeys = expected.protocol === undefined
    ? ["schema", "name", "version", "sourceCommit"]
    : ["schema", "name", "version", "protocol", "sourceCommit"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    buildFailure(`${label} --build-info must contain exactly ${expectedKeys.join(", ")}`);
  }
  if (record.schema !== RUNTIME_BUILD_INFO_SCHEMA) {
    buildFailure(`${label} --build-info schema must equal ${RUNTIME_BUILD_INFO_SCHEMA}`);
  }
  if (record.name !== expected.name) {
    buildFailure(`${label} --build-info name must equal ${expected.name}`);
  }
  if (typeof record.version !== "string" || !SEMANTIC_VERSION_PATTERN.test(record.version)) {
    buildFailure(`${label} --build-info version must be a semantic version`);
  }
  if (expected.version !== undefined && record.version !== expected.version) {
    buildFailure(`${label} --build-info version must equal ${expected.version}`);
  }
  if (typeof record.sourceCommit !== "string" || !SOURCE_COMMIT_PATTERN.test(record.sourceCommit)) {
    buildFailure(`${label} --build-info sourceCommit must be a full lowercase source commit SHA`);
  }
  if (record.sourceCommit !== expected.sourceCommit) {
    buildFailure(
      `${label} --build-info sourceCommit must equal the required v0 source commit ${expected.sourceCommit}`,
    );
  }

  if (expected.protocol !== undefined) {
    const protocol = record.protocol;
    if (typeof protocol !== "number" || protocol !== expected.protocol) {
      buildFailure(`${label} --build-info protocol must equal ${expected.protocol}`);
    }
    return { sourceCommit: record.sourceCommit, version: record.version, protocol };
  }
  return { sourceCommit: record.sourceCommit, version: record.version };
}

async function readBuildInfo(
  binaryPath: string,
  label: string,
  expected: ExpectedBuildInfo,
  dependencies: RuntimeBundleBuilderDependencies,
): Promise<RuntimeBuildInfo> {
  const process = (dependencies.spawnBuildInfoProbe ?? defaultSpawnBuildInfoProbe)(binaryPath);
  let hasExited = false;
  const exited = process.exited.finally(() => {
    hasExited = true;
  });
  const result = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    exited,
  ]);
  const timeout = Promise.withResolvers<never>();
  const timeoutMs = dependencies.buildInfoProbeTimeoutMs ?? BUILD_INFO_PROBE_TIMEOUT_MS;
  const timeoutError = new Error(`${label} --build-info timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => timeout.reject(timeoutError), timeoutMs);
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.race([result, timeout.promise]);
  } catch (error) {
    if (!hasExited) {
      try {
        await terminateBuildInfoProbe(
          process,
          exited,
          dependencies.buildInfoProbeTerminationGraceMs ?? BUILD_INFO_PROBE_TERMINATION_GRACE_MS,
        );
      } catch (terminationError) {
        throw new AggregateError(
          [error, terminationError],
          `${label} --build-info failed and exact child termination also failed`,
        );
      }
    }
    if (error === timeoutError) buildFailure(timeoutError.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (exitCode !== 0) buildFailure(`${label} --build-info exited ${exitCode}: ${(stderr || stdout).trim()}`);
  return parseBuildInfoJsonl(stdout, stderr, label, expected);
}

function copyArtifact(sourcePath: string, destinationRoot: string, destinationName: string, executable: boolean): string {
  const destinationPath = join(destinationRoot, destinationName);
  copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
  chmodSync(destinationPath, executable ? 0o755 : 0o644);
  return createHash("sha256").update(readFileSync(destinationPath)).digest("hex");
}

export function projectRootFromFileUrl(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

function parseArguments(arguments_: readonly string[]): BuildRuntimeBundleInput {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === undefined || !flag.startsWith("--")) buildFailure(`unexpected argument ${String(flag)}`);
    if (!["--herdr-bin", "--omp-bin", "--output"].includes(flag)) {
      buildFailure(`unknown argument ${flag}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) buildFailure(`${flag} requires a value`);
    if (values.has(flag)) buildFailure(`${flag} may be provided only once`);
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) buildFailure(`${flag} is required`);
    return value;
  };
  const output = values.get("--output");
  return {
    herdrBin: required("--herdr-bin"),
    ompBin: required("--omp-bin"),
    ...(output === undefined ? {} : { output }),
  };
}

export async function buildRuntimeBundle(
  input: BuildRuntimeBundleInput,
  dependencies: RuntimeBundleBuilderDependencies = {},
): Promise<BuiltRuntimeBundle> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    buildFailure(`target ${LINUX_X64_RUNTIME_TARGET} requires Linux x64, got ${process.platform}-${process.arch}`);
  }
  const root = projectRootFromFileUrl(import.meta.url);
  const sheltiePath = assertInputArtifact(input.sheltiePath ?? join(root, "dist", "sheltie"), "dist/sheltie", true);
  const okfCompactionPath = assertInputArtifact(
    input.okfCompactionPath ?? join(root, "dist", "sheltie-okf-compaction.js"),
    "dist/sheltie-okf-compaction.js",
    false,
  );
  const herdrPath = assertInputArtifact(input.herdrBin, "--herdr-bin", true);
  const ompPath = assertInputArtifact(input.ompBin, "--omp-bin", true);
  const output = resolve(input.output ?? join(root, "dist", "runtime"));
  if (lstatIfPresent(output) !== null) buildFailure(`output directory already exists: ${output}`);
  const outputParent = dirname(output);
  mkdirSync(outputParent, { recursive: true, mode: 0o755 });
  assertTrustedOutputParent(outputParent);
  const temporaryOutput = join(outputParent, `.${basename(output)}.${randomUUID()}.tmp`);
  mkdirSync(temporaryOutput, { mode: 0o700 });
  try {
    const sheltieSha256 = copyArtifact(sheltiePath, temporaryOutput, "sheltie", true);
    const herdrSha256 = copyArtifact(herdrPath, temporaryOutput, "herdr", true);
    const ompSha256 = copyArtifact(ompPath, temporaryOutput, "omp", true);
    const okfCompactionSha256 = copyArtifact(okfCompactionPath, temporaryOutput, "sheltie-okf-compaction.js", false);
    const [herdrProbe, ompProbe] = await Promise.allSettled([
      readBuildInfo(
        join(temporaryOutput, "herdr"),
        "Herdr",
        {
          name: "herdr",
          sourceCommit: REQUIRED_V0_HERDR_SOURCE_COMMIT,
          version: HERDR_VERSION,
          protocol: HERDR_PROTOCOL,
        },
        dependencies,
      ),
      readBuildInfo(
        join(temporaryOutput, "omp"),
        "OMP",
        { name: "omp", sourceCommit: REQUIRED_V0_OMP_SOURCE_COMMIT },
        dependencies,
      ),
    ]);
    if (herdrProbe.status === "rejected") throw herdrProbe.reason;
    if (ompProbe.status === "rejected") throw ompProbe.reason;
    const manifest: RuntimeBundleManifest = {
      apiVersion: RUNTIME_BUNDLE_API_VERSION,
      target: LINUX_X64_RUNTIME_TARGET,
      artifacts: {
        sheltie: { path: "sheltie", sha256: sheltieSha256 },
        herdr: {
          path: "herdr",
          sha256: herdrSha256,
          sourceCommit: herdrProbe.value.sourceCommit,
          version: herdrProbe.value.version,
          protocol: herdrProbe.value.protocol!,
        },
        omp: {
          path: "omp",
          sha256: ompSha256,
          sourceCommit: ompProbe.value.sourceCommit,
          version: ompProbe.value.version,
        },
        okfCompaction: { path: "sheltie-okf-compaction.js", sha256: okfCompactionSha256 },
      },
    };
    const manifestJson = canonicalJson(manifest);
    const digest = createHash("sha256").update(manifestJson).digest("hex");
    writeFileSync(join(temporaryOutput, "runtime-manifest.json"), manifestJson, { encoding: "utf8", mode: 0o644, flag: "wx" });
    renameSync(temporaryOutput, output);
    return { root: output, digest, manifest };
  } catch (error) {
    rmSync(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  buildRuntimeBundle(parseArguments(Bun.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
