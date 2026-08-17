import { describe, expect, test } from "bun:test";
import { HerdrApiError, type PongResult, type HerdrClient } from "../src/herdr-client.ts";
import {
  BundledHerdrRuntime,
  controlledHerdrEnvironment,
  type BundledHerdrAttachInput,
  type BundledHerdrCommandInput,
  type BundledHerdrSpawnInput,
} from "../src/herdr-runtime.ts";
import {
  REQUIRED_V0_HERDR_SOURCE_COMMIT,
  REQUIRED_V0_OMP_SOURCE_COMMIT,
  type BundledRuntimeBinding,
} from "../src/runtime-bundle.ts";

const SESSION_NAME = "s-0123456789abcdef";
const CONFIG_HOME = "/tmp/sheltie-herdr-1000/0123456789abcdef01234567";
const SOCKET_PATH = `${CONFIG_HOME}/herdr/sessions/${SESSION_NAME}/herdr.sock`;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const COMMIT_A = REQUIRED_V0_HERDR_SOURCE_COMMIT;
const COMMIT_B = REQUIRED_V0_OMP_SOURCE_COMMIT;

function bundledBinding(): BundledRuntimeBinding {
  return {
    mode: "bundled",
    bundleRoot: "/runtime-bundle",
    bundleDigest: SHA_A,
    bundleTarget: "linux-x64",
    sessionName: SESSION_NAME,
    configHome: CONFIG_HOME,
    socketPath: SOCKET_PATH,
    pathPrefix: "/runtime-bundle",
    sheltie: { path: "/runtime-bundle/sheltie", sha256: SHA_B },
    herdr: {
      path: "/runtime-bundle/herdr",
      sha256: SHA_C,
      sourceCommit: COMMIT_A,
      version: "0.8.0",
      protocol: 20,
    },
    omp: { path: "/runtime-bundle/omp", sha256: SHA_D, sourceCommit: COMMIT_B, version: "1.2.3" },
    okfCompaction: { path: "/runtime-bundle/sheltie-okf-compaction.js", sha256: SHA_A },
  };
}

function clientFor(ping: () => Promise<PongResult>): HerdrClient {
  return { ping } as unknown as HerdrClient;
}

function pong(): PongResult {
  return { type: "pong", version: "0.8.0", protocol: 20, capabilities: null };
}

function socketError(code: string): Error & { code: string } {
  return Object.assign(new Error(`socket failed with ${code}`), { code });
}

const indeterminatePingFailures = [
  { name: "times out", create: () => new Error("ping timed out after 1000ms") },
  { name: "fails generically", create: () => new Error("unexpected ping failure") },
  { name: "is denied", create: () => socketError("EACCES") },
  { name: "returns a non-Error ENOENT object", create: () => ({ code: "ENOENT" }) },
  {
    name: "returns a server ENOENT API error",
    create: () => new HerdrApiError("ENOENT", "server-provided failure", "request-enoent"),
  },
  {
    name: "returns a server ECONNREFUSED API error",
    create: () => new HerdrApiError("ECONNREFUSED", "server-provided failure", "request-econnrefused"),
  },
];

describe("bundled Herdr runtime", () => {
  test("removes inherited Herdr routing state, replaces the OMP binding, and prefixes only the bundled runtime", () => {
    const environment = controlledHerdrEnvironment(bundledBinding(), {
      PATH: "/ambient/bin",
      XDG_CONFIG_HOME: "/foreign/config",
      HERDR_SOCKET_PATH: "/foreign/socket",
      HERDR_CLIENT_SOCKET_PATH: "/foreign/client.sock",
      HERDR_SESSION: "foreign-session",
      HERDR_PANE_ID: "foreign-pane",
      HERDR_AGENT_OMP_PATH: "/ambient/omp",
      SAFE_VALUE: "kept",
    });

    expect(environment).toMatchObject({
      PATH: "/runtime-bundle:/ambient/bin",
      XDG_CONFIG_HOME: CONFIG_HOME,
      HERDR_AGENT_OMP_PATH: "/runtime-bundle/omp",
      SAFE_VALUE: "kept",
    });
    expect(Object.entries(environment).filter(([key]) => key.startsWith("HERDR_"))).toEqual([
      ["HERDR_AGENT_OMP_PATH", "/runtime-bundle/omp"],
    ]);
  });

  test("starts only the exact named bundled Herdr and waits for its socket ping", async () => {
    let pingCalls = 0;
    let clock = 0;
    const spawns: BundledHerdrSpawnInput[] = [];
    const runtime = new BundledHerdrRuntime(bundledBinding(), {
      environment: { PATH: "/ambient/bin", HERDR_SOCKET_PATH: "/foreign.sock" },
      createClient: () => clientFor(async () => {
        pingCalls += 1;
        if (pingCalls < 3) {
          throw socketError(pingCalls === 1 ? "ENOENT" : "ECONNREFUSED");
        }
        return pong();
      }),
      spawn: (input) => {
        spawns.push(input);
        return {
          exited: new Promise<number>(() => {}),
          terminate: async () => {
            throw new Error("healthy startup must not terminate the spawned process");
          },
        };
      },
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await runtime.ensureRunning();

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      argv: ["/runtime-bundle/herdr", "--session", SESSION_NAME, "server"],
      env: {
        PATH: "/runtime-bundle:/ambient/bin",
        XDG_CONFIG_HOME: CONFIG_HOME,
        HERDR_AGENT_OMP_PATH: "/runtime-bundle/omp",
      },
      stdoutPath: `${CONFIG_HOME}/herdr.stdout.log`,
      stderrPath: `${CONFIG_HOME}/herdr.stderr.log`,
    });
    expect(Object.keys(spawns[0]!.env).filter((key) => key.startsWith("HERDR_"))).toEqual([
      "HERDR_AGENT_OMP_PATH",
    ]);
    expect(pingCalls).toBe(3);
  });

  test("reuses a healthy exact socket without starting a second Herdr", async () => {
    let spawns = 0;
    const runtime = new BundledHerdrRuntime(bundledBinding(), {
      createClient: () => clientFor(async () => pong()),
      spawn: () => {
        spawns += 1;
        throw new Error("must not spawn when the exact socket is healthy");
      },
    });

    await runtime.ensureRunning();

    expect(spawns).toBe(0);
    await expect(runtime.status()).resolves.toMatchObject({ state: "running", socketPath: SOCKET_PATH });
  });

  test("surfaces an early exit from the exact spawned binary without an ambient retry", async () => {
    let spawns = 0;
    const runtime = new BundledHerdrRuntime(bundledBinding(), {
      createClient: () => clientFor(async () => {
        throw socketError("ENOENT");
      }),
      spawn: () => {
        spawns += 1;
        return {
          exited: Promise.resolve(17),
          terminate: async () => undefined,
        };
      },
      now: () => 0,
      sleep: async () => undefined,
    });

    await expect(runtime.ensureRunning()).rejects.toThrow("exited before readiness");
    expect(spawns).toBe(1);
  });

  test("awaits exact-child termination when readiness times out", async () => {
    let clock = 0;
    let terminationCompleted = false;
    const exit = Promise.withResolvers<number>();
    const runtime = new BundledHerdrRuntime(bundledBinding(), {
      createClient: () => clientFor(async () => {
        throw socketError("ENOENT");
      }),
      spawn: () => ({
        exited: exit.promise,
        terminate: async () => {
          exit.resolve(143);
          await exit.promise;
          terminationCompleted = true;
        },
      }),
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await expect(runtime.ensureRunning()).rejects.toThrow("did not answer ping");
    expect(terminationCompleted).toBe(true);
  });

  test("delegates attach to the exact named bundled session under the controlled environment", async () => {
    const attaches: BundledHerdrAttachInput[] = [];
    const runtime = new BundledHerdrRuntime(bundledBinding(), {
      environment: { PATH: "/ambient/bin", HERDR_SESSION: "foreign" },
      createClient: () => clientFor(async () => pong()),
      attach: async (input) => {
        attaches.push(input);
        return 0;
      },
    });

    await runtime.attach();

    expect(attaches).toEqual([
      {
        argv: ["/runtime-bundle/herdr", "session", "attach", SESSION_NAME],
        env: {
          PATH: "/runtime-bundle:/ambient/bin",
          XDG_CONFIG_HOME: CONFIG_HOME,
          HERDR_AGENT_OMP_PATH: "/runtime-bundle/omp",
        },
      },
    ]);
  });

  test("stops the exact named session once and readbacks an idempotent stopped state", async () => {
    let running = true;
    let clock = 0;
    const commands: BundledHerdrCommandInput[] = [];
    const runtime = new BundledHerdrRuntime(bundledBinding(), {
      environment: {},
      createClient: () => clientFor(async () => {
        if (!running) throw socketError("ENOENT");
        return pong();
      }),
      run: async (input) => {
        commands.push(input);
        running = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await expect(runtime.stop()).resolves.toMatchObject({ state: "stopped", socketPath: SOCKET_PATH });
    await expect(runtime.stop()).resolves.toMatchObject({ state: "stopped", socketPath: SOCKET_PATH });

    expect(commands).toEqual([
      expect.objectContaining({
        argv: ["/runtime-bundle/herdr", "session", "stop", SESSION_NAME],
        timeoutMs: 20_000,
      }),
    ]);
  });

  for (const { name, create } of indeterminatePingFailures) {
    test(`does not mutate lifecycle state when the socket ping ${name}`, async () => {
      let spawnCalls = 0;
      let commandCalls = 0;
      const runtime = new BundledHerdrRuntime(bundledBinding(), {
        createClient: () => clientFor(async () => {
          throw create();
        }),
        spawn: () => {
          spawnCalls += 1;
          throw new Error("must not spawn when ping state is indeterminate");
        },
        run: async () => {
          commandCalls += 1;
          throw new Error("must not stop when ping state is indeterminate");
        },
      });

      await expect(runtime.ensureRunning()).rejects.toThrow("cannot determine exact bundled Herdr session state");
      await expect(runtime.stop()).rejects.toThrow("check the session socket, server health, and permissions");

      expect(spawnCalls).toBe(0);
      expect(commandCalls).toBe(0);
    });
  }
  test("recognizes Node socket errno failures as stopped without lifecycle mutation", async () => {
    for (const code of ["ENOENT", "ECONNREFUSED"]) {
      let spawnCalls = 0;
      let commandCalls = 0;
      const runtime = new BundledHerdrRuntime(bundledBinding(), {
        createClient: () => clientFor(async () => {
          throw socketError(code);
        }),
        spawn: () => {
          spawnCalls += 1;
          throw new Error("must not spawn when the socket is definitively stopped");
        },
        run: async () => {
          commandCalls += 1;
          throw new Error("must not issue stop when the socket is definitively stopped");
        },
      });

      await expect(runtime.status()).resolves.toMatchObject({ state: "stopped", socketPath: SOCKET_PATH });
      await expect(runtime.stop()).resolves.toMatchObject({ state: "stopped", socketPath: SOCKET_PATH });

      expect(spawnCalls).toBe(0);
      expect(commandCalls).toBe(0);
    }
  });


  test("refuses to stop an incompatible socket that it does not own", async () => {
    let commandCalls = 0;
    const runtime = new BundledHerdrRuntime(bundledBinding(), {
      createClient: () => clientFor(async () => ({ type: "pong", version: "9.0.0", protocol: 99, capabilities: null })),
      run: async () => {
        commandCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await expect(runtime.stop()).rejects.toThrow("refusing to stop incompatible runtime");
    expect(commandCalls).toBe(0);
  });
});
