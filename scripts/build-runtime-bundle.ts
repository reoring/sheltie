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
import {
  LINUX_X64_RUNTIME_TARGET,
  REQUIRED_V0_HERDR_SOURCE_COMMIT,
  REQUIRED_V0_OMP_SOURCE_COMMIT,
  RUNTIME_BUNDLE_API_VERSION,
  type RuntimeBundleManifest,
} from "../src/runtime-bundle.ts";

const HERDR_VERSION = "0.8.0";
const HERDR_PROTOCOL = 20;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const VERSION_PATTERN = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;
const GROUP_OR_OTHER_WRITABLE_MODE_MASK = 0o022;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TERMINATION_GRACE_MS = 1_000;

export interface BuildRuntimeBundleInput {
  /** An exact release Herdr artifact; stable `--version` cannot prove release mode. */
  herdrBin: string;
  herdrCommit: string;
  ompBin: string;
  ompCommit: string;
  output?: string;
  sheltiePath?: string;
  okfCompactionPath?: string;
}

export interface BuiltRuntimeBundle {
  root: string;
  digest: string;
  manifest: RuntimeBundleManifest;
}

export interface RuntimeVersionProbeProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export interface RuntimeBundleBuilderDependencies {
  spawnVersionProbe?: (binaryPath: string) => RuntimeVersionProbeProcess;
  versionProbeTimeoutMs?: number;
  versionProbeTerminationGraceMs?: number;
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

function requireSourceCommit(value: string, label: string, required: string): string {
  if (!SOURCE_COMMIT_PATTERN.test(value)) buildFailure(`${label} must be a full lowercase source commit SHA`);
  if (value !== required) buildFailure(`${label} must equal the required v0 source commit ${required}`);
  return value;
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

function defaultSpawnVersionProbe(binaryPath: string): RuntimeVersionProbeProcess {
  const child = Bun.spawn([binaryPath, "--version"], {
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

async function waitForVersionProbeExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
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

async function terminateVersionProbe(
  process: RuntimeVersionProbeProcess,
  exited: Promise<number>,
  terminationGraceMs: number,
): Promise<void> {
  process.kill("SIGTERM");
  if (await waitForVersionProbeExit(exited, terminationGraceMs)) return;
  process.kill("SIGKILL");
  await exited;
}

async function readVersion(
  binaryPath: string,
  label: string,
  dependencies: RuntimeBundleBuilderDependencies,
): Promise<{ version: string; output: string }> {
  const process = (dependencies.spawnVersionProbe ?? defaultSpawnVersionProbe)(binaryPath);
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
  const timeoutMs = dependencies.versionProbeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  const timeoutError = new Error(`${label} --version timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => timeout.reject(timeoutError), timeoutMs);
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.race([result, timeout.promise]);
  } catch (error) {
    if (!hasExited) {
      try {
        await terminateVersionProbe(
          process,
          exited,
          dependencies.versionProbeTerminationGraceMs ?? VERSION_PROBE_TERMINATION_GRACE_MS,
        );
      } catch (terminationError) {
        throw new AggregateError(
          [error, terminationError],
          `${label} --version failed and exact child termination also failed`,
        );
      }
    }
    if (error === timeoutError) buildFailure(timeoutError.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (exitCode !== 0) buildFailure(`${label} --version exited ${exitCode}: ${(stderr || stdout).trim()}`);
  const output = `${stdout}\n${stderr}`.trim();
  const version = output.match(VERSION_PATTERN)?.[0];
  if (version === undefined) buildFailure(`${label} --version did not report a semantic version`);
  return { version, output };
}

function copyArtifact(sourcePath: string, destinationRoot: string, destinationName: string, executable: boolean): string {
  const destinationPath = join(destinationRoot, destinationName);
  copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
  chmodSync(destinationPath, executable ? 0o755 : 0o644);
  return createHash("sha256").update(readFileSync(destinationPath)).digest("hex");
}

function projectRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

function parseArguments(arguments_: readonly string[]): BuildRuntimeBundleInput {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === undefined || !flag.startsWith("--")) buildFailure(`unexpected argument ${String(flag)}`);
    if (!["--herdr-bin", "--herdr-commit", "--omp-bin", "--omp-commit", "--output"].includes(flag)) {
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
    herdrCommit: required("--herdr-commit"),
    ompBin: required("--omp-bin"),
    ompCommit: required("--omp-commit"),
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
  const root = projectRoot();
  const sheltiePath = assertInputArtifact(input.sheltiePath ?? join(root, "dist", "sheltie"), "dist/sheltie", true);
  const okfCompactionPath = assertInputArtifact(
    input.okfCompactionPath ?? join(root, "dist", "sheltie-okf-compaction.js"),
    "dist/sheltie-okf-compaction.js",
    false,
  );
  const herdrPath = assertInputArtifact(input.herdrBin, "--herdr-bin", true);
  const ompPath = assertInputArtifact(input.ompBin, "--omp-bin", true);
  const herdrCommit = requireSourceCommit(input.herdrCommit, "--herdr-commit", REQUIRED_V0_HERDR_SOURCE_COMMIT);
  const ompCommit = requireSourceCommit(input.ompCommit, "--omp-commit", REQUIRED_V0_OMP_SOURCE_COMMIT);
  // --herdr-bin is explicitly release provenance. Stable Herdr --version
  // cannot distinguish a debug binary, so the caller's exact commit and file
  // digest are retained in the bundle manifest and binding.
  const [herdrVersion, ompVersion] = await Promise.all([
    readVersion(herdrPath, "Herdr", dependencies),
    readVersion(ompPath, "OMP", dependencies),
  ]);
  if (herdrVersion.version !== HERDR_VERSION) {
    buildFailure(`Herdr version ${herdrVersion.version} is unsupported; expected ${HERDR_VERSION}`);
  }

  const output = resolve(input.output ?? join(root, "dist", "runtime"));
  if (lstatIfPresent(output) !== null) buildFailure(`output directory already exists: ${output}`);
  const outputParent = dirname(output);
  mkdirSync(outputParent, { recursive: true, mode: 0o755 });
  const temporaryOutput = join(outputParent, `.${basename(output)}.${randomUUID()}.tmp`);
  mkdirSync(temporaryOutput, { mode: 0o755 });
  try {
    const sheltieSha256 = copyArtifact(sheltiePath, temporaryOutput, "sheltie", true);
    const herdrSha256 = copyArtifact(herdrPath, temporaryOutput, "herdr", true);
    const ompSha256 = copyArtifact(ompPath, temporaryOutput, "omp", true);
    const okfCompactionSha256 = copyArtifact(okfCompactionPath, temporaryOutput, "sheltie-okf-compaction.js", false);
    const manifest: RuntimeBundleManifest = {
      apiVersion: RUNTIME_BUNDLE_API_VERSION,
      target: LINUX_X64_RUNTIME_TARGET,
      artifacts: {
        sheltie: { path: "sheltie", sha256: sheltieSha256 },
        herdr: {
          path: "herdr",
          sha256: herdrSha256,
          sourceCommit: herdrCommit,
          version: herdrVersion.version,
          protocol: HERDR_PROTOCOL,
        },
        omp: {
          path: "omp",
          sha256: ompSha256,
          sourceCommit: ompCommit,
          version: ompVersion.version,
        },
        okfCompaction: { path: "sheltie-okf-compaction.js", sha256: okfCompactionSha256 },
      },
    };
    const manifestJson = canonicalJson(manifest);
    writeFileSync(join(temporaryOutput, "runtime-manifest.json"), manifestJson, { encoding: "utf8", mode: 0o644, flag: "wx" });
    renameSync(temporaryOutput, output);
    return {
      root: output,
      digest: createHash("sha256").update(manifestJson).digest("hex"),
      manifest,
    };
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
