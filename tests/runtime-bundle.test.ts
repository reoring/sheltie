import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_V0_HERDR_PROTOCOL,
  REQUIRED_V0_HERDR_SOURCE_COMMIT,
  REQUIRED_V0_HERDR_VERSION,
  REQUIRED_V0_OMP_SOURCE_COMMIT,
  assertRuntimeBundleMatchesBinding,
  RUNTIME_BUNDLE_API_VERSION,
  createBundledRuntimeBinding,
  parseRuntimeBinding,
  resolveRuntimeBundle,
  type RuntimeBundleManifest,
} from "../src/runtime-bundle.ts";
import { requestHash } from "../src/ids.ts";

const roots: string[] = [];
const runtimeHomes: string[] = [];
const directoryModes: Array<{ path: string; mode: number }> = [];
const HERDR_COMMIT = REQUIRED_V0_HERDR_SOURCE_COMMIT;
const OMP_COMMIT = REQUIRED_V0_OMP_SOURCE_COMMIT;

afterEach(() => {
  for (const { path, mode } of directoryModes.splice(0).reverse()) chmodSync(path, mode);
  for (const runtimeHome of runtimeHomes.splice(0)) rmSync(runtimeHome, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createBundleBelowAncestor(root: string, name: string, mode: number): string {
  const ancestor = join(root, name);
  mkdirSync(ancestor, { mode: 0o700 });
  directoryModes.push({ path: ancestor, mode: lstatSync(ancestor).mode & 0o7777 });
  if ((mode & 0o1000) !== 0) {
    // Bun's chmodSync strips special permission bits.
    const result = Bun.spawnSync(["/usr/bin/chmod", mode.toString(8), ancestor], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) throw new Error(`could not set sticky mode on ${ancestor}`);
  } else {
    chmodSync(ancestor, mode);
  }
  return createBundle(ancestor);
}


function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createBundle(root: string, name = "bundle"): string {
  const bundle = join(root, name);
  mkdirSync(bundle, { mode: 0o700 });
  const contents = {
    sheltie: "#!/bin/sh\necho sheltie\n",
    herdr: "#!/bin/sh\necho 'herdr 0.8.0 release'\n",
    omp: "#!/bin/sh\necho 'omp 1.2.3'\n",
    okfCompaction: "export default {};\n",
  };
  writeFileSync(join(bundle, "sheltie"), contents.sheltie, { mode: 0o755 });
  writeFileSync(join(bundle, "herdr"), contents.herdr, { mode: 0o755 });
  writeFileSync(join(bundle, "omp"), contents.omp, { mode: 0o755 });
  writeFileSync(join(bundle, "sheltie-okf-compaction.js"), contents.okfCompaction, { mode: 0o644 });
  const manifest: RuntimeBundleManifest = {
    apiVersion: RUNTIME_BUNDLE_API_VERSION,
    target: "linux-x64",
    artifacts: {
      sheltie: { path: "sheltie", sha256: sha256(contents.sheltie) },
      herdr: {
        path: "herdr",
        sha256: sha256(contents.herdr),
        sourceCommit: HERDR_COMMIT,
        version: "0.8.0",
        protocol: 20,
      },
      omp: {
        path: "omp",
        sha256: sha256(contents.omp),
        sourceCommit: OMP_COMMIT,
        version: "1.2.3",
      },
      okfCompaction: { path: "sheltie-okf-compaction.js", sha256: sha256(contents.okfCompaction) },
    },
  };
  writeFileSync(join(bundle, "runtime-manifest.json"), JSON.stringify(manifest), { mode: 0o644 });
  return bundle;
}

describe("runtime bundle resolution", () => {
  test("retains artifact identity after the complete bundle is relocated", () => {
    const root = temporaryRoot("sheltie-runtime-relocate-");
    const original = createBundle(root);
    const before = resolveRuntimeBundle({ sheltieExecutable: join(original, "sheltie") });
    const relocated = join(root, "relocated-runtime");
    renameSync(original, relocated);

    const after = resolveRuntimeBundle({ sheltieExecutable: join(relocated, "sheltie") });

    expect(after.root).toBe(relocated);
    expect(after.digest).toBe(before.digest);
    expect(after.herdr).toMatchObject({
      path: join(relocated, "herdr"),
      sourceCommit: HERDR_COMMIT,
      version: "0.8.0",
      protocol: 20,
    });
    expect(after.omp).toMatchObject({ path: join(relocated, "omp"), sourceCommit: OMP_COMMIT, version: "1.2.3" });
  });

  test("canonicalizes an intermediate-symlink runtime directory before persisting artifact paths", () => {
    const root = temporaryRoot("sheltie-runtime-canonical-");
    const canonicalParent = join(root, "canonical-parent");
    mkdirSync(canonicalParent, { mode: 0o700 });
    const canonicalBundle = createBundle(canonicalParent);
    const linkedParent = join(root, "linked-parent");
    symlinkSync(canonicalParent, linkedParent, "dir");
    const stateRoot = join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });

    const bundle = resolveRuntimeBundle({
      sheltieExecutable: join(linkedParent, "bundle", "sheltie"),
      runtimeDir: join(linkedParent, "bundle"),
    });
    const binding = createBundledRuntimeBinding(bundle, stateRoot, "run-canonical");
    runtimeHomes.push(binding.configHome);

    expect(bundle.root).toBe(canonicalBundle);
    expect(binding.bundleRoot).toBe(canonicalBundle);
    expect(binding.pathPrefix).toBe(canonicalBundle);
    expect(binding.sheltie.path).toBe(join(canonicalBundle, "sheltie"));
    expect(binding.herdr.path).toBe(join(canonicalBundle, "herdr"));
    expect(binding.omp.path).toBe(join(canonicalBundle, "omp"));
    expect(binding.okfCompaction.path).toBe(join(canonicalBundle, "sheltie-okf-compaction.js"));
  });

  test("accepts private and sticky writable bundle ancestors", () => {
    const root = temporaryRoot("sheltie-runtime-ancestor-");
    const privateBundle = createBundleBelowAncestor(root, "private-ancestor", 0o700);
    const stickyBundle = createBundleBelowAncestor(root, "sticky-ancestor", 0o1777);

    expect(resolveRuntimeBundle({ sheltieExecutable: join(privateBundle, "sheltie") }).root).toBe(privateBundle);
    expect(resolveRuntimeBundle({ sheltieExecutable: join(stickyBundle, "sheltie") }).root).toBe(stickyBundle);
  });

  test("rejects non-sticky writable bundle ancestors", () => {
    const root = temporaryRoot("sheltie-runtime-ancestor-");

    for (const mode of [0o770, 0o777] as const) {
      const bundle = createBundleBelowAncestor(root, `non-sticky-${mode.toString(8)}`, mode);
      expect(() => resolveRuntimeBundle({ sheltieExecutable: join(bundle, "sheltie") })).toThrow(
        "runtime bundle ancestor grants group or other write access without the sticky bit",
      );
    }
  });

  test("rejects otherwise-valid manifests from non-required fork commits", () => {
    const root = temporaryRoot("sheltie-runtime-required-commits-");
    const herdrBundle = createBundle(root, "wrong-herdr");
    const herdrManifestPath = join(herdrBundle, "runtime-manifest.json");
    const herdrManifest = JSON.parse(readFileSync(herdrManifestPath, "utf8")) as RuntimeBundleManifest;
    herdrManifest.artifacts.herdr.sourceCommit = "a".repeat(40);
    writeFileSync(herdrManifestPath, JSON.stringify(herdrManifest), { mode: 0o644 });
    expect(() => resolveRuntimeBundle({ sheltieExecutable: join(herdrBundle, "sheltie") })).toThrow(
      REQUIRED_V0_HERDR_SOURCE_COMMIT,
    );

    const ompBundle = createBundle(root, "wrong-omp");
    const ompManifestPath = join(ompBundle, "runtime-manifest.json");
    const ompManifest = JSON.parse(readFileSync(ompManifestPath, "utf8")) as RuntimeBundleManifest;
    ompManifest.artifacts.omp.sourceCommit = "b".repeat(40);
    writeFileSync(ompManifestPath, JSON.stringify(ompManifest), { mode: 0o644 });
    expect(() => resolveRuntimeBundle({ sheltieExecutable: join(ompBundle, "sheltie") })).toThrow(
      REQUIRED_V0_OMP_SOURCE_COMMIT,
    );
  });

  test("accepts only the exact v0 Herdr version and protocol in manifests and bindings", () => {
    const root = temporaryRoot("sheltie-runtime-herdr-identity-");
    const manifestBundle = createBundle(root, "manifest");
    const manifestPath = join(manifestBundle, "runtime-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeBundleManifest;
    manifest.artifacts.herdr.version = "0.8.1";
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o644 });

    expect(() => resolveRuntimeBundle({ sheltieExecutable: join(manifestBundle, "sheltie") })).toThrow(
      REQUIRED_V0_HERDR_VERSION,
    );

    const protocolBundle = createBundle(root, "protocol");
    const protocolManifestPath = join(protocolBundle, "runtime-manifest.json");
    const protocolManifest = JSON.parse(readFileSync(protocolManifestPath, "utf8")) as RuntimeBundleManifest;
    protocolManifest.artifacts.herdr.protocol = REQUIRED_V0_HERDR_PROTOCOL + 1;
    writeFileSync(protocolManifestPath, JSON.stringify(protocolManifest), { mode: 0o644 });

    expect(() => resolveRuntimeBundle({ sheltieExecutable: join(protocolBundle, "sheltie") })).toThrow(
      String(REQUIRED_V0_HERDR_PROTOCOL),
    );

    const stateRoot = join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const binding = createBundledRuntimeBinding(
      resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root, "binding"), "sheltie") }),
      stateRoot,
      "run-herdr-identity",
    );
    runtimeHomes.push(binding.configHome);

    expect(() =>
      parseRuntimeBinding({
        ...binding,
        herdr: { ...binding.herdr, version: "0.8.1" },
      }),
    ).toThrow(REQUIRED_V0_HERDR_VERSION);
    expect(() =>
      parseRuntimeBinding({
        ...binding,
        herdr: { ...binding.herdr, protocol: REQUIRED_V0_HERDR_PROTOCOL + 1 },
      }),
    ).toThrow(String(REQUIRED_V0_HERDR_PROTOCOL));
  });

  test("rejects a tampered executable rather than using an ambient replacement", () => {
    const root = temporaryRoot("sheltie-runtime-digest-");
    const bundle = createBundle(root);
    writeFileSync(join(bundle, "omp"), "#!/bin/sh\necho ambient replacement\n", { mode: 0o755 });

    expect(() => resolveRuntimeBundle({ sheltieExecutable: join(bundle, "sheltie") })).toThrow("OMP runtime SHA-256 mismatch");
  });

  test("rejects manifest traversal and symlinked runtime artifacts", () => {
    const root = temporaryRoot("sheltie-runtime-safe-path-");
    const bundle = createBundle(root);
    const manifestPath = join(bundle, "runtime-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeBundleManifest;
    manifest.artifacts.herdr.path = "../herdr";
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o644 });
    expect(() => resolveRuntimeBundle({ sheltieExecutable: join(bundle, "sheltie") })).toThrow("relative basename herdr");

    const safeBundle = createBundle(root, "safe-bundle");
    rmSync(join(safeBundle, "omp"));
    symlinkSync(join(bundle, "sheltie"), join(safeBundle, "omp"));
    expect(() => resolveRuntimeBundle({ sheltieExecutable: join(safeBundle, "sheltie") })).toThrow("must not be a symbolic link");
  });

  test("requires the current Sheltie executable to match the selected bundle artifact", () => {
    const root = temporaryRoot("sheltie-runtime-sheltie-identity-");
    const bundle = createBundle(root);
    const matchingExecutable = join(root, "matching-sheltie");
    const mismatchingExecutable = join(root, "mismatching-sheltie");
    writeFileSync(matchingExecutable, readFileSync(join(bundle, "sheltie")), { mode: 0o755 });
    writeFileSync(mismatchingExecutable, "#!/bin/sh\necho another sheltie\n", { mode: 0o755 });

    expect(
      resolveRuntimeBundle({
        sheltieExecutable: matchingExecutable,
        runtimeDir: bundle,
      }).root,
    ).toBe(bundle);
    expect(() =>
      resolveRuntimeBundle({
        sheltieExecutable: mismatchingExecutable,
        runtimeDir: bundle,
      }),
    ).toThrow("current Sheltie executable does not match the selected bundle artifact");
  });

  test("creates deterministic short private binding paths and rejects unrecognized persisted fields", () => {
    const root = temporaryRoot("sheltie-runtime-binding-");
    const bundle = resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root), "sheltie") });
    const stateRoot = join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const binding = createBundledRuntimeBinding(bundle, stateRoot, "run-alpha");
    runtimeHomes.push(binding.configHome);
    const runHash = requestHash({ stateRoot, bundleDigest: bundle.digest, runId: "run-alpha" }).slice(0, 24);
    const runtimeRoot = join(realpathSync(tmpdir()), `sheltie-herdr-${process.geteuid!()}`);

    expect(parseRuntimeBinding(binding)).toEqual(binding);
    expect(binding).toMatchObject({
      mode: "bundled",
      bundleRoot: bundle.root,
      bundleDigest: bundle.digest,
      sessionName: `s-${runHash.slice(0, 16)}`,
      configHome: join(runtimeRoot, runHash),
      pathPrefix: bundle.root,
      herdr: { path: join(bundle.root, "herdr"), protocol: 20 },
      omp: { path: join(bundle.root, "omp"), version: "1.2.3" },
    });
    expect(binding.socketPath).toBe(
      join(binding.configHome, "herdr", "sessions", binding.sessionName, "herdr.sock"),
    );
    expect(Buffer.byteLength(binding.socketPath, "utf8")).toBeLessThanOrEqual(107);
    for (const path of [
      runtimeRoot,
      binding.configHome,
      join(binding.configHome, "herdr"),
      join(binding.configHome, "herdr", "sessions"),
      join(binding.configHome, "herdr", "sessions", binding.sessionName),
    ]) {
      const details = lstatSync(path);
      expect(details.isSymbolicLink()).toBe(false);
      expect(details.mode & 0o077).toBe(0);
    }
    expect(createBundledRuntimeBinding(bundle, stateRoot, "run-alpha")).toEqual(binding);
    expect(createBundledRuntimeBinding(bundle, stateRoot, "  run-alpha  ")).toEqual(binding);
    expect(() => parseRuntimeBinding({ ...binding, ambientHerdr: "/usr/bin/herdr" })).toThrow("exactly");
  });

  test("canonicalizes TMPDIR before persisting Herdr runtime paths", () => {
    const root = temporaryRoot("t-");
    const bundle = resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root), "sheltie") });
    const stateRoot = join(root, "s");
    const canonicalTmpdir = join(root, "t");
    const linkedTmpdir = join(root, "l");
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(canonicalTmpdir, { mode: 0o700 });
    symlinkSync(canonicalTmpdir, linkedTmpdir, "dir");

    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = linkedTmpdir;
      const binding = createBundledRuntimeBinding(bundle, stateRoot, "r");
      runtimeHomes.push(binding.configHome);

      expect(binding.configHome.startsWith(join(canonicalTmpdir, `sheltie-herdr-${process.geteuid!()}`))).toBe(true);
      expect(binding.configHome).not.toContain(linkedTmpdir);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  test("accepts the sticky root-owned /tmp runtime root", () => {
    const root = temporaryRoot("sheltie-runtime-sticky-tmpdir-");
    const bundle = resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root), "sheltie") });
    const stateRoot = join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });

    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = "/tmp";
      const binding = createBundledRuntimeBinding(bundle, stateRoot, "run-sticky-tmpdir");
      runtimeHomes.push(binding.configHome);

      expect(binding.configHome.startsWith(join("/tmp", `sheltie-herdr-${process.geteuid!()}`))).toBe(true);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  test("rejects TMPDIR with a non-sticky writable ancestor", () => {
    const root = temporaryRoot("sheltie-runtime-tmpdir-ancestor-");
    const bundle = resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root), "sheltie") });
    const stateRoot = join(root, "state");
    const unsafeAncestor = join(root, "unsafe-ancestor");
    const temporaryTmpdir = join(unsafeAncestor, "tmpdir");
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(unsafeAncestor, { mode: 0o700 });
    directoryModes.push({ path: unsafeAncestor, mode: lstatSync(unsafeAncestor).mode & 0o7777 });
    chmodSync(unsafeAncestor, 0o777);
    mkdirSync(temporaryTmpdir, { mode: 0o700 });

    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = temporaryTmpdir;
      expect(() => createBundledRuntimeBinding(bundle, stateRoot, "run-unsafe-tmpdir")).toThrow(
        "temporary directory ancestor grants group or other write access without the sticky bit",
      );
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  test("isolates same run and bundle bindings across private state roots", () => {
    const root = temporaryRoot("sheltie-runtime-binding-isolation-");
    const bundle = resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root), "sheltie") });
    const firstStateRoot = join(root, "first-state");
    const secondStateRoot = join(root, "second-state");
    mkdirSync(firstStateRoot, { mode: 0o700 });
    mkdirSync(secondStateRoot, { mode: 0o700 });

    const first = createBundledRuntimeBinding(bundle, firstStateRoot, "run-alpha");
    const second = createBundledRuntimeBinding(bundle, secondStateRoot, "run-alpha");
    runtimeHomes.push(first.configHome, second.configHome);

    expect(first.configHome).not.toBe(second.configHome);
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.sessionName).not.toBe(second.sessionName);
  });

  test("validates current artifacts without re-deriving persisted paths after TMPDIR drift", () => {
    const root = temporaryRoot("d-");
    const bundle = resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root), "sheltie") });
    const stateRoot = join(root, "s");
    const firstTmpdir = join(root, "a");
    const secondTmpdir = join(root, "b");
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(firstTmpdir, { mode: 0o700 });
    mkdirSync(secondTmpdir, { mode: 0o700 });
    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = firstTmpdir;
      const binding = createBundledRuntimeBinding(bundle, stateRoot, "run-drift");
      runtimeHomes.push(binding.configHome);
      const persistedConfigHome = binding.configHome;
      const persistedSocketPath = binding.socketPath;

      process.env.TMPDIR = secondTmpdir;
      const currentBundle = resolveRuntimeBundle({
        sheltieExecutable: binding.sheltie.path,
        runtimeDir: binding.bundleRoot,
      });

      expect(() => assertRuntimeBundleMatchesBinding(currentBundle, binding)).not.toThrow();
      expect(binding.configHome).toBe(persistedConfigHome);
      expect(binding.socketPath).toBe(persistedSocketPath);
      expect(binding.configHome.startsWith(firstTmpdir)).toBe(true);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  test("rejects an existing symlinked shared runtime root", () => {
    const root = temporaryRoot("r-");
    const bundle = resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root), "sheltie") });
    const stateRoot = join(root, "s");
    const temporaryTmpdir = root;
    const foreignDirectory = join(root, "f");
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(foreignDirectory, { mode: 0o700 });
    symlinkSync(foreignDirectory, join(temporaryTmpdir, `sheltie-herdr-${process.geteuid!()}`));

    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = temporaryTmpdir;
    try {
      expect(() => createBundledRuntimeBinding(bundle, stateRoot, "run-alpha")).toThrow("must not be a symbolic link");
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  test("rejects a final Unix socket path above the conservative byte ceiling", () => {
    const root = temporaryRoot("sheltie-runtime-binding-socket-limit-");
    const bundle = resolveRuntimeBundle({ sheltieExecutable: join(createBundle(root), "sheltie") });
    const stateRoot = join(root, "state");
    const temporaryTmpdir = join(root, `temporary-tmpdir-${"x".repeat(120)}`);
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(temporaryTmpdir, { mode: 0o700 });

    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = temporaryTmpdir;
    try {
      expect(() => createBundledRuntimeBinding(bundle, stateRoot, "run-alpha")).toThrow("socketPath is");
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  test("preserves the legacy external binding only as the exact explicit shape", () => {
    expect(parseRuntimeBinding({ mode: "external" })).toEqual({ mode: "external" });
    expect(() => parseRuntimeBinding({ mode: "external", socketPath: "/foreign.sock" })).toThrow("exactly");
  });

  test("requires executable artifacts to be executable by the current effective identity", () => {
    const root = temporaryRoot("sheltie-runtime-executable-");
    const bundle = createBundle(root);
    const herdr = join(bundle, "herdr");
    const resolves = () => resolveRuntimeBundle({ sheltieExecutable: join(bundle, "sheltie") });

    chmodSync(herdr, 0o000);
    expect(resolves).toThrow("not executable");

    for (const mode of [0o401, 0o410] as const) {
      chmodSync(herdr, mode);
      if (process.geteuid!() === 0) expect(resolves).not.toThrow();
      else expect(resolves).toThrow("not executable");
    }

    chmodSync(herdr, 0o500);
    expect(resolves).not.toThrow();
  });
});
