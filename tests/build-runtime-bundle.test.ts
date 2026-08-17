import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRuntimeBundle,
  type BuildRuntimeBundleInput,
  type RuntimeVersionProbeProcess,
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
    herdrCommit: REQUIRED_V0_HERDR_SOURCE_COMMIT,
    ompBin: ompPath,
    ompCommit: REQUIRED_V0_OMP_SOURCE_COMMIT,
    output: join(root, "runtime"),
    sheltiePath,
    okfCompactionPath,
  };
}

function completedProbe(output: string): RuntimeVersionProbeProcess {
  return {
    stdout: new Response(output).body!,
    stderr: new Response("").body!,
    exited: Promise.resolve(0),
    kill: () => {
      throw new Error("completed version probe must not be signalled");
    },
  };
}

describe("runtime bundle builder", () => {
  test("rejects full source SHAs that are not the exact required v0 fork commits", async () => {
    const input = createBuildInput();
    let spawnCalls = 0;
    const dependencies = {
      spawnVersionProbe: () => {
        spawnCalls += 1;
        return completedProbe("unused 1.2.3");
      },
    };

    await expect(
      buildRuntimeBundle({ ...input, herdrCommit: "a".repeat(40) }, dependencies),
    ).rejects.toThrow(REQUIRED_V0_HERDR_SOURCE_COMMIT);
    await expect(
      buildRuntimeBundle({ ...input, ompCommit: "b".repeat(40) }, dependencies),
    ).rejects.toThrow(REQUIRED_V0_OMP_SOURCE_COMMIT);
    expect(spawnCalls).toBe(0);
  });

  test("terminates and awaits a wedged exact version-probe child before failing", async () => {
    const input = createBuildInput();
    const exit = Promise.withResolvers<number>();
    const signals: NodeJS.Signals[] = [];
    let exitResolved = false;
    const wedgedProbe: RuntimeVersionProbeProcess = {
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
        spawnVersionProbe: (binaryPath) =>
          binaryPath === input.herdrBin ? wedgedProbe : completedProbe("omp 1.2.3"),
        versionProbeTimeoutMs: 5,
        versionProbeTerminationGraceMs: 5,
      }),
    ).rejects.toThrow("Herdr --version timed out");

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(exitResolved).toBe(true);
  });
});
