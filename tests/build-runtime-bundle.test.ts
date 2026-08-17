import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildRuntimeBundle,
  projectRootFromFileUrl,
  type BuildRuntimeBundleInput,
  type RuntimeBuildInfoProbeProcess,
} from "../scripts/build-runtime-bundle.ts";
import {
  REQUIRED_V0_HERDR_SOURCE_COMMIT,
  REQUIRED_V0_OMP_SOURCE_COMMIT,
} from "../src/runtime-bundle.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createBuildInput(): BuildRuntimeBundleInput {
  const root = mkdtempSync(join(tmpdir(), "sheltie-build-runtime-bundle-"));
  roots.push(root);
  const sheltiePath = join(root, "sheltie");
  const herdrPath = join(root, "herdr");
  const ompPath = join(root, "omp");
  const okfCompactionPath = join(root, "sheltie-okf-compaction.js");
  writeFileSync(sheltiePath, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(herdrPath, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(ompPath, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(okfCompactionPath, "export default {};\n", { mode: 0o644 });
  return {
    herdrBin: herdrPath,
    ompBin: ompPath,
    output: join(root, "runtime"),
    sheltiePath,
    okfCompactionPath,
  };
}

function completedProbe(
  stdout: string,
  exitCode = 0,
  stderr = "",
): RuntimeBuildInfoProbeProcess {
  return {
    stdout: new Response(stdout).body!,
    stderr: new Response(stderr).body!,
    exited: Promise.resolve(exitCode),
    kill: () => {
      throw new Error("completed build-info probe must not be signalled");
    },
  };
}

function buildInfoRecord(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function herdrBuildInfo(overrides: Record<string, unknown> = {}): string {
  return buildInfoRecord({
    schema: "sheltie.runtime-build-info/v1",
    name: "herdr",
    version: "0.8.0",
    protocol: 20,
    sourceCommit: REQUIRED_V0_HERDR_SOURCE_COMMIT,
    ...overrides,
  });
}

function ompBuildInfo(overrides: Record<string, unknown> = {}): string {
  return buildInfoRecord({
    schema: "sheltie.runtime-build-info/v1",
    name: "omp",
    version: "1.2.3",
    sourceCommit: REQUIRED_V0_OMP_SOURCE_COMMIT,
    ...overrides,
  });
}

function replaceArtifact(path: string, contents: string, mode: number): void {
  const replacementPath = `${path}.replacement`;
  writeFileSync(replacementPath, contents, { mode });
  renameSync(replacementPath, path);
}

function expectNoBundle(input: BuildRuntimeBundleInput): void {
  expect(existsSync(input.output!)).toBe(false);
  const temporaryPrefix = `.${basename(input.output!)}.`;
  expect(readdirSync(dirname(input.output!)).some((entry) => entry.startsWith(temporaryPrefix) && entry.endsWith(".tmp"))).toBe(
    false,
  );
}

describe("runtime bundle builder", () => {
  test("decodes special-character file URLs to their checkout root", () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie build # % 日本語-"));
    roots.push(root);
    const modulePath = join(root, "scripts", "build-runtime-bundle.ts");
    mkdirSync(dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, "");

    const moduleUrl = pathToFileURL(modulePath).href;
    expect(moduleUrl).toContain("%20");
    expect(moduleUrl).toContain("%23");
    expect(moduleUrl).toContain("%25");
    expect(moduleUrl).toContain("%E6");
    expect(projectRootFromFileUrl(moduleUrl)).toBe(root);
  });

  test("records only matching artifact build-info source commits in the manifest", async () => {
    const input = createBuildInput();

    const bundle = await buildRuntimeBundle(input, {
      spawnBuildInfoProbe: (binaryPath) =>
        basename(binaryPath) === "herdr" ? completedProbe(herdrBuildInfo()) : completedProbe(ompBuildInfo()),
    });
    expect(bundle.manifest.artifacts.herdr).toMatchObject({
      sourceCommit: REQUIRED_V0_HERDR_SOURCE_COMMIT,
      version: "0.8.0",
      protocol: 20,
    });
    expect(bundle.manifest.artifacts.omp).toMatchObject({
      sourceCommit: REQUIRED_V0_OMP_SOURCE_COMMIT,
      version: "1.2.3",
    });
    expect(existsSync(input.output!)).toBe(true);
  });

  test("probes and publishes a private snapshot when source inputs change", async () => {
    const input = createBuildInput();
    const originalArtifacts = {
      sheltie: readFileSync(input.sheltiePath!, "utf8"),
      herdr: readFileSync(input.herdrBin, "utf8"),
      omp: readFileSync(input.ompBin, "utf8"),
      okfCompaction: readFileSync(input.okfCompactionPath!, "utf8"),
    };
    let sourcesReplaced = false;

    const bundle = await buildRuntimeBundle(input, {
      spawnBuildInfoProbe: (binaryPath) => {
        if (basename(binaryPath) === "herdr") {
          expect(binaryPath).not.toBe(input.herdrBin);
          expect(readFileSync(binaryPath, "utf8")).toBe(originalArtifacts.herdr);
          replaceArtifact(input.sheltiePath!, "#!/bin/sh\nexit 11\n", 0o755);
          replaceArtifact(input.herdrBin, "#!/bin/sh\nexit 12\n", 0o755);
          replaceArtifact(input.ompBin, "#!/bin/sh\nexit 13\n", 0o755);
          replaceArtifact(input.okfCompactionPath!, "export default { changed: true };\n", 0o644);
          sourcesReplaced = true;
          return completedProbe(herdrBuildInfo());
        }
        expect(basename(binaryPath)).toBe("omp");
        expect(binaryPath).not.toBe(input.ompBin);
        expect(readFileSync(binaryPath, "utf8")).toBe(originalArtifacts.omp);
        return completedProbe(ompBuildInfo());
      },
    });

    expect(sourcesReplaced).toBe(true);
    expect(readFileSync(join(input.output!, "sheltie"), "utf8")).toBe(originalArtifacts.sheltie);
    expect(readFileSync(join(input.output!, "herdr"), "utf8")).toBe(originalArtifacts.herdr);
    expect(readFileSync(join(input.output!, "omp"), "utf8")).toBe(originalArtifacts.omp);
    expect(readFileSync(join(input.output!, "sheltie-okf-compaction.js"), "utf8")).toBe(originalArtifacts.okfCompaction);
    const publishedManifest = JSON.parse(
      readFileSync(join(input.output!, "runtime-manifest.json"), "utf8"),
    ) as typeof bundle.manifest;
    expect(publishedManifest).toEqual(bundle.manifest);
    expect(publishedManifest.artifacts.sheltie.sha256).toBe(
      createHash("sha256").update(originalArtifacts.sheltie).digest("hex"),
    );
    expect(publishedManifest.artifacts.herdr.sha256).toBe(
      createHash("sha256").update(originalArtifacts.herdr).digest("hex"),
    );
    expect(publishedManifest.artifacts.omp.sha256).toBe(
      createHash("sha256").update(originalArtifacts.omp).digest("hex"),
    );
    expect(publishedManifest.artifacts.okfCompaction.sha256).toBe(
      createHash("sha256").update(originalArtifacts.okfCompaction).digest("hex"),
    );
  });

  const invalidBuildInfoCases = [
    {
      description: "a record missing a required field",
      herdrOutput: buildInfoRecord({
        schema: "sheltie.runtime-build-info/v1",
        name: "herdr",
        version: "0.8.0",
        protocol: 20,
      }),
      error: "must contain exactly",
    },
    {
      description: "malformed JSON",
      herdrOutput: "{not-json}\n",
      error: "must contain valid JSON",
    },
    {
      description: "multiline build-info output",
      herdrOutput: `${herdrBuildInfo()}\n`,
      error: "must write exactly one JSONL record",
    },
    {
      description: "extra build-info output",
      herdrOutput: `${herdrBuildInfo()}unexpected`,
      error: "must write exactly one JSONL record",
    },
    {
      description: "a wrong build-info schema",
      herdrOutput: herdrBuildInfo({ schema: "other.schema/v1" }),
      error: "schema must equal sheltie.runtime-build-info/v1",
    },
    {
      description: "a wrong build-info name",
      herdrOutput: herdrBuildInfo({ name: "omp" }),
      error: "name must equal herdr",
    },
    {
      description: "a wrong Herdr version",
      herdrOutput: herdrBuildInfo({ version: "0.8.1" }),
      error: "version must equal 0.8.0",
    },
    {
      description: "a wrong Herdr protocol",
      herdrOutput: herdrBuildInfo({ protocol: 19 }),
      error: "protocol must equal 20",
    },
    {
      description: "a wrong Herdr source SHA",
      herdrOutput: herdrBuildInfo({ sourceCommit: "a".repeat(40) }),
      error: REQUIRED_V0_HERDR_SOURCE_COMMIT,
    },
    {
      description: "an OMP record with a non-semantic version",
      ompOutput: ompBuildInfo({ version: "not-a-version" }),
      error: "OMP --build-info version must be a semantic version",
    },
    {
      description: "a wrong OMP source SHA",
      ompOutput: ompBuildInfo({ sourceCommit: "b".repeat(40) }),
      error: REQUIRED_V0_OMP_SOURCE_COMMIT,
    },
  ];

  for (const { description, herdrOutput = herdrBuildInfo(), ompOutput = ompBuildInfo(), error } of invalidBuildInfoCases) {
    test(`rejects ${description} without leaving bundle output`, async () => {
      const input = createBuildInput();

      await expect(
        buildRuntimeBundle(input, {
          spawnBuildInfoProbe: (binaryPath) =>
            basename(binaryPath) === "herdr" ? completedProbe(herdrOutput) : completedProbe(ompOutput),
        }),
      ).rejects.toThrow(error);

      expectNoBundle(input);
    });
  }

  test("rejects a nonzero build-info probe without leaving bundle output", async () => {
    const input = createBuildInput();

    await expect(
      buildRuntimeBundle(input, {
        spawnBuildInfoProbe: (binaryPath) =>
          basename(binaryPath) === "herdr"
            ? completedProbe(herdrBuildInfo(), 7, "probe failed")
            : completedProbe(ompBuildInfo()),
      }),
    ).rejects.toThrow("Herdr --build-info exited 7");

    expectNoBundle(input);
  });

  test("terminates and awaits a wedged exact build-info probe before failing", async () => {
    const input = createBuildInput();
    const exit = Promise.withResolvers<number>();
    const signals: NodeJS.Signals[] = [];
    let exitResolved = false;
    const wedgedProbe: RuntimeBuildInfoProbeProcess = {
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: exit.promise,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          exitResolved = true;
          exit.resolve(137);
        }
      },
    };

    await expect(
      buildRuntimeBundle(input, {
        spawnBuildInfoProbe: (binaryPath) =>
          basename(binaryPath) === "herdr" ? wedgedProbe : completedProbe(ompBuildInfo()),
        buildInfoProbeTimeoutMs: 5,
        buildInfoProbeTerminationGraceMs: 5,
      }),
    ).rejects.toThrow("Herdr --build-info timed out");

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(exitResolved).toBe(true);
    expectNoBundle(input);
  });

  test("awaits a wedged sibling after an immediate probe failure", async () => {
    const input = createBuildInput();
    const exit = Promise.withResolvers<number>();
    const signals: NodeJS.Signals[] = [];
    let exitResolved = false;
    const wedgedProbe: RuntimeBuildInfoProbeProcess = {
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: exit.promise,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          exitResolved = true;
          exit.resolve(137);
        }
      },
    };

    await expect(
      buildRuntimeBundle(input, {
        spawnBuildInfoProbe: (binaryPath) =>
          basename(binaryPath) === "herdr"
            ? completedProbe(herdrBuildInfo(), 7, "probe failed")
            : wedgedProbe,
        buildInfoProbeTimeoutMs: 5,
        buildInfoProbeTerminationGraceMs: 5,
      }),
    ).rejects.toThrow("Herdr --build-info exited 7");

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(exitResolved).toBe(true);
    expectNoBundle(input);
  });
});
