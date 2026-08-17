import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectBundledWorkspaceEnvironment,
  runtimeExecutionOptions,
  resolveRuntimeStartSelection,
  runCli,
  type BundledRuntimeControl,
  type RuntimeCliDependencies,
} from "../src/cli.ts";
import { SheltieStore } from "../src/db.ts";
import { initDisposableRepo } from "../src/git.ts";
import { HerdrClient } from "../src/herdr-client.ts";
import { resolveManifestFile, type ResolvedManifestDocument } from "../src/manifest.ts";
import {
  REQUIRED_V0_HERDR_SOURCE_COMMIT,
  REQUIRED_V0_OMP_SOURCE_COMMIT,
  assertRuntimeBundleMatchesBinding,
  parseRuntimeBinding,
  type BundledRuntimeBinding,
  type RuntimeBundle,
} from "../src/runtime-bundle.ts";

const roots: string[] = [];

interface Fixture {
  root: string;
  statePath: string;
  binding: BundledRuntimeBinding;
}

interface StartFixture extends Fixture {
  manifestPath: string;
  repoRoot: string;
}

interface CapturedOutput {
  stdout: string;
  stderr: string;
}

function writeManifest(path: string): ResolvedManifestDocument {
  writeFileSync(
    path,
    `apiVersion: sheltie.dev/v1alpha1
kind: Run
metadata:
  name: runtime-cli
spec:
  root:
    role: coordinator
    name: root
  limits:
    maxDepth: 1
    maxChildrenPerNode: 1
    maxDescendants: 1
    maxParallelNodes: 1
  roles:
    coordinator:
      placement: workspace
      agent:
        kind: omp
      prompt:
        inline: "runtime CLI fixture"
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: []
          receiveFrom: []
`,
  );
  return resolveManifestFile(path);
}

function createBundledBindingFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sheltie-runtime-cli-"));
  roots.push(root);
  const statePath = join(root, "state");
  const bundleRoot = join(root, "BUNDLE_ROOT_MUST_NOT_LEAK");
  const configHome = join(root, "PRIVATE_CONFIG_HOME_MUST_NOT_LEAK");
  const sessionName = `sheltie-${"1".repeat(24)}`;
  mkdirSync(statePath, { mode: 0o700 });
  const binding = parseRuntimeBinding({
    mode: "bundled",
    bundleRoot,
    bundleDigest: "a".repeat(64),
    bundleTarget: "linux-x64",
    sessionName,
    configHome,
    socketPath: join(configHome, "herdr", "sessions", sessionName, "herdr.sock"),
    pathPrefix: bundleRoot,
    sheltie: { path: join(bundleRoot, "sheltie"), sha256: "b".repeat(64) },
    herdr: {
      path: join(bundleRoot, "herdr"),
      sha256: "c".repeat(64),
      sourceCommit: REQUIRED_V0_HERDR_SOURCE_COMMIT,
      version: "0.8.0",
      protocol: 20,
    },
    omp: {
      path: join(bundleRoot, "omp"),
      sha256: "e".repeat(64),
      sourceCommit: REQUIRED_V0_OMP_SOURCE_COMMIT,
      version: "0.8.0",
    },
    okfCompaction: { path: join(bundleRoot, "sheltie-okf-compaction.js"), sha256: "0".repeat(64) },
  });
  if (binding.mode !== "bundled") throw new Error("bundled fixture binding was not parsed as bundled");
  return { root, statePath, binding };
}

function createBundledFixture(): Fixture {
  const fixture = createBundledBindingFixture();
  const manifest = writeManifest(join(fixture.root, "sheltie.yaml"));
  const store = new SheltieStore(join(fixture.statePath, "state.sqlite"));
  try {
    store.createManifestTree(
      {
        manifestDigest: manifest.digest,
        apiVersion: manifest.manifest.apiVersion,
        resolved: manifest.manifest,
      },
      {
        treeId: "tree-runtime-cli",
        runId: "run-runtime-cli",
        repoRoot: join(fixture.root, "repo"),
        repoSourceWorkspaceId: null,
        herdrSocketPath: fixture.binding.socketPath,
        herdrVersion: "0.8.0",
        herdrProtocol: 20,
        runtimeBinding: fixture.binding,
        baseCommit: "1".repeat(40),
        worktreeRoot: join(fixture.statePath, "worktrees"),
        rootTaskContract: "runtime CLI fixture",
        rootSpawnPolicy: "workspace",
        manifestDigest: manifest.digest,
        rootRole: "coordinator",
        status: "initializing",
      },
    );
  } finally {
    store.close();
  }
  return fixture;
}

async function createBundledStartFixture(): Promise<StartFixture> {
  const fixture = createBundledBindingFixture();
  const manifestPath = join(fixture.root, "sheltie.yaml");
  writeManifest(manifestPath);
  const repoRoot = join(fixture.root, "repo");
  await initDisposableRepo(repoRoot);
  return { ...fixture, manifestPath, repoRoot };
}

function createExternalFixture(): { statePath: string } {
  const root = mkdtempSync(join(tmpdir(), "sheltie-runtime-cli-external-"));
  roots.push(root);
  const statePath = join(root, "state");
  mkdirSync(statePath, { mode: 0o700 });
  const manifest = writeManifest(join(root, "sheltie.yaml"));
  const store = new SheltieStore(join(statePath, "state.sqlite"));
  try {
    store.createManifestTree(
      {
        manifestDigest: manifest.digest,
        apiVersion: manifest.manifest.apiVersion,
        resolved: manifest.manifest,
      },
      {
        treeId: "tree-runtime-cli-external",
        runId: "run-runtime-cli-external",
        repoRoot: join(root, "repo"),
        repoSourceWorkspaceId: null,
        herdrSocketPath: "/tmp/foreign-herdr.sock",
        herdrVersion: "0.8.0",
        herdrProtocol: 20,
        runtimeBinding: parseRuntimeBinding({ mode: "external" }),
        baseCommit: "1".repeat(40),
        worktreeRoot: join(statePath, "worktrees"),
        rootTaskContract: "runtime CLI fixture",
        rootSpawnPolicy: "workspace",
        manifestDigest: manifest.digest,
        rootRole: "coordinator",
        status: "initializing",
      },
    );
  } finally {
    store.close();
  }
  return { statePath };
}

function createRuntimeDependencies(
  binding: BundledRuntimeBinding,
  runtime: BundledRuntimeControl,
): Partial<RuntimeCliDependencies> {
  const bundle = {
    root: binding.bundleRoot,
    digest: binding.bundleDigest,
    target: binding.bundleTarget,
    manifest: {} as RuntimeBundle["manifest"],
    sheltie: binding.sheltie,
    herdr: binding.herdr,
    omp: binding.omp,
    okfCompaction: binding.okfCompaction,
  } satisfies RuntimeBundle;
  return {
    resolveRuntimeBundle: () => bundle,
    createBundledRuntimeBinding: () => {
      throw new Error("persisted runtime paths must not be recomputed");
    },
    assertRuntimeBundleMatchesBinding,
    createBundledRuntime: () => runtime,
    controlledHerdrEnvironment: () => ({ PATH: binding.pathPrefix }),
  };
}

function createBundledStartDependencies(
  binding: BundledRuntimeBinding,
  runtime: BundledRuntimeControl,
): Partial<RuntimeCliDependencies> {
  return {
    ...createRuntimeDependencies(binding, runtime),
    createBundledRuntimeBinding: () => binding,
  };
}

function mockRunStartHerdr() {
  let agent: {
    terminal_id: string;
    agent_instance_id: string;
    name: string;
    agent: string;
    agent_status: "idle";
    workspace_id: string;
    tab_id: string;
    pane_id: string;
    launch_pending: false;
    interactive_ready: true;
  } | null = null;
  return spyOn(HerdrClient.prototype, "request").mockImplementation(async (method, params) => {
    const requestParams = params ?? {};
    if (method === "ping") {
      return { type: "pong", version: "0.8.0", protocol: 20, capabilities: null } as never;
    }
    if (method === "session.snapshot") {
      return {
        type: "session_snapshot",
        snapshot: { version: "0.8.0", protocol: 20, workspaces: [], tabs: [], panes: [], agents: [] },
      } as never;
    }
    if (method === "workspace.create") {
      const cwd = requestParams.cwd;
      const label = requestParams.label;
      if (typeof cwd !== "string" || typeof label !== "string") throw new Error("workspace fixture request is invalid");
      return {
        type: "workspace_created",
        workspace: {
          workspace_id: "w-runtime-cli",
          label,
          focused: false,
          active_tab_id: "w-runtime-cli:t1",
          worktree: { repo_root: cwd, checkout_path: cwd, is_linked_worktree: false },
        },
        tab: { workspace_id: "w-runtime-cli", tab_id: "w-runtime-cli:t1" },
        root_pane: {
          pane_id: "w-runtime-cli:p1",
          workspace_id: "w-runtime-cli",
          tab_id: "w-runtime-cli:t1",
          agent_status: "idle",
        },
      } as never;
    }
    if (method === "tab.rename") {
      return { type: "tab_info", tab: { workspace_id: "w-runtime-cli", tab_id: "w-runtime-cli:t1" } } as never;
    }
    if (method === "agent.start") {
      const name = requestParams.name;
      const paneId = requestParams.pane_id;
      if (typeof name !== "string" || typeof paneId !== "string") throw new Error("agent fixture request is invalid");
      agent = {
        terminal_id: `terminal-${name}`,
        agent_instance_id: `instance-${name}`,
        name,
        agent: "omp",
        agent_status: "idle",
        workspace_id: "w-runtime-cli",
        tab_id: "w-runtime-cli:t1",
        pane_id: paneId,
        launch_pending: false,
        interactive_ready: true,
      };
      return { type: "agent_started", agent, argv: ["omp"] } as never;
    }
    if (method === "agent.get") {
      if (agent === null) throw new Error("agent fixture was not started");
      return { type: "agent_info", agent } as never;
    }
    if (method === "agent.prompt") {
      if (agent === null) throw new Error("agent fixture was not started");
      return { type: "agent_prompted", agent, turn_id: "turn-runtime-cli", duplicate: false } as never;
    }
    throw new Error(`unexpected Herdr fixture request ${method}`);
  });
}

async function captureOutput(operation: () => Promise<void>): Promise<CapturedOutput> {
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await operation();
    return {
      stdout: stdout.mock.calls.map(([value]) => String(value)).join(""),
      stderr: stderr.mock.calls.map(([value]) => String(value)).join(""),
    };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run start runtime selection", () => {
  test("defaults to the bundle and keeps sockets as explicit external mode", () => {
    expect(resolveRuntimeStartSelection([])).toEqual({ mode: "bundled" });
    expect(resolveRuntimeStartSelection(["--herdr-socket", "/tmp/external.sock"])).toEqual({
      mode: "external",
      socketPath: "/tmp/external.sock",
    });
    expect(() => resolveRuntimeStartSelection(["--runtime", "bundled", "--herdr-socket", "/tmp/external.sock"])).toThrow(
      "cannot be combined",
    );
    expect(() => resolveRuntimeStartSelection(["--runtime", "external"])).toThrow("requires --herdr-socket");
    expect(() => resolveRuntimeStartSelection(["--runtime-dir", "/tmp/runtime", "--herdr-socket", "/tmp/external.sock"])).toThrow(
      "valid only with bundled",
    );
  });

  test("projects only PATH into persisted workspace requests", () => {
    expect(
      projectBundledWorkspaceEnvironment({
        PATH: "/bundle:/usr/bin",
        OPENAI_API_KEY: "must-not-be-persisted",
        XDG_CONFIG_HOME: "/private/herdr",
      }),
    ).toEqual({ PATH: "/bundle:/usr/bin" });
  });

  test("uses persisted non-adjacent executable and extension paths only for bundled execution", () => {
    const fixture = createBundledFixture();

    expect(runtimeExecutionOptions(fixture.binding)).toEqual({
      sheltieExecutable: fixture.binding.sheltie.path,
      okfCompactionExtensionPath: fixture.binding.okfCompaction.path,
    });
    expect(runtimeExecutionOptions(parseRuntimeBinding({ mode: "external" }))).toEqual({
      sheltieExecutable: process.execPath,
    });
  });
});

describe("runtime lifecycle CLI", () => {
  test("uses the persisted bundle binding without leaking runtime locators in normal status", async () => {
    const fixture = createBundledFixture();
    let ensureCalls = 0;
    let stopCalls = 0;
    let attachCalls = 0;
    const runtime: BundledRuntimeControl = {
      ensureRunning: async () => {
        ensureCalls += 1;
      },
      status: async () => ({
        state: "running",
        sessionName: fixture.binding.sessionName,
        socketPath: fixture.binding.socketPath,
        version: "0.8.0",
        protocol: 20,
      }),
      stop: async () => {
        stopCalls += 1;
        return {
          state: "stopped",
          sessionName: fixture.binding.sessionName,
          socketPath: fixture.binding.socketPath,
        };
      },
      attach: async () => {
        attachCalls += 1;
      },
    };
    const dependencies = createRuntimeDependencies(fixture.binding, runtime);

    const safe = await captureOutput(() => runCli(["runtime", "status", "--state", fixture.statePath], dependencies));
    expect(safe.stdout).toContain('"mode":"bundled"');
    expect(safe.stdout).toContain('"state":"running"');
    expect(safe.stdout).not.toContain(fixture.root);
    expect(safe.stdout).not.toContain(fixture.binding.sessionName);
    expect(safe.stdout).not.toContain(fixture.binding.socketPath);

    const unsafe = await captureOutput(() =>
      runCli(["runtime", "status", "--state", fixture.statePath, "--unsafe-output"], dependencies),
    );
    expect(unsafe.stdout).toContain(fixture.root);
    expect(unsafe.stdout).toContain(fixture.binding.sessionName);

    await runCli(["runtime", "stop", "--state", fixture.statePath], dependencies);
    await runCli(["runtime", "attach", "--state", fixture.statePath], dependencies);
    expect({ ensureCalls, stopCalls, attachCalls }).toEqual({ ensureCalls: 0, stopCalls: 1, attachCalls: 1 });
  });

  test("rejects stop and attach for an external binding before any foreign runtime control", async () => {
    const fixture = createExternalFixture();

    await expect(runCli(["runtime", "stop", "--state", fixture.statePath])).rejects.toThrow("external Herdr socket");
    await expect(runCli(["runtime", "attach", "--state", fixture.statePath])).rejects.toThrow("external Herdr socket");
  });
  test("starts only the durable reservation winner and never stops its session", async () => {
    const fixture = await createBundledStartFixture();
    const runtimeStarted = Promise.withResolvers<void>();
    const releaseRuntime = Promise.withResolvers<void>();
    let ensureCalls = 0;
    let stopCalls = 0;
    const runtimeStartObservation: { tree: { runId: string; status: string } | null } = { tree: null };
    const runtime: BundledRuntimeControl = {
      ensureRunning: async () => {
        ensureCalls += 1;
        const databasePath = join(fixture.statePath, "state.sqlite");
        if (existsSync(databasePath)) {
          const stateStore = new SheltieStore(databasePath);
          try {
            const tree = stateStore.getOnlyTree();
            runtimeStartObservation.tree = { runId: tree.runId, status: tree.status };
          } catch {
            runtimeStartObservation.tree = null;
          } finally {
            stateStore.close();
          }
        } else {
          runtimeStartObservation.tree = null;
        }
        runtimeStarted.resolve();
        await releaseRuntime.promise;
      },
      status: async () => ({
        state: "running",
        sessionName: fixture.binding.sessionName,
        socketPath: fixture.binding.socketPath,
        version: fixture.binding.herdr.version,
        protocol: fixture.binding.herdr.protocol,
      }),
      stop: async () => {
        stopCalls += 1;
        return {
          state: "stopped",
          sessionName: fixture.binding.sessionName,
          socketPath: fixture.binding.socketPath,
        };
      },
      attach: async () => {},
    };
    const dependencies = createBundledStartDependencies(fixture.binding, runtime);
    const request = mockRunStartHerdr();
    const startArguments = [
      "run",
      "start",
      "--state",
      fixture.statePath,
      "--manifest",
      fixture.manifestPath,
      "--repo",
      fixture.repoRoot,
      "--run-id",
      "runtime-cli-concurrent",
      "--once",
    ];
    let outcomes: PromiseSettledResult<void>[] = [];
    try {
      await captureOutput(async () => {
        const first = runCli(startArguments, dependencies);
        const second = runCli(startArguments, dependencies);
        const settled = Promise.allSettled([first, second]);
        await runtimeStarted.promise;
        releaseRuntime.resolve();
        outcomes = await settled;
      });
    } finally {
      request.mockRestore();
    }

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect({ ensureCalls, stopCalls }).toEqual({ ensureCalls: 1, stopCalls: 0 });
    expect(runtimeStartObservation.tree).toEqual({ runId: "runtime-cli-concurrent", status: "initializing" });
    const store = new SheltieStore(join(fixture.statePath, "state.sqlite"));
    try {
      expect(store.getOnlyTree()).toMatchObject({
        runId: "runtime-cli-concurrent",
        status: "active",
        runtimeBinding: fixture.binding,
      });
    } finally {
      store.close();
    }
  });

  test("retains the bundled tree when post-reservation startup fails", async () => {
    const fixture = await createBundledStartFixture();
    let ensureCalls = 0;
    let stopCalls = 0;
    const runtime: BundledRuntimeControl = {
      ensureRunning: async () => {
        ensureCalls += 1;
        throw new Error("runtime startup failed");
      },
      status: async () => ({
        state: "stopped",
        sessionName: fixture.binding.sessionName,
        socketPath: fixture.binding.socketPath,
      }),
      stop: async () => {
        stopCalls += 1;
        return {
          state: "stopped",
          sessionName: fixture.binding.sessionName,
          socketPath: fixture.binding.socketPath,
        };
      },
      attach: async () => {},
    };

    await expect(
      captureOutput(() =>
        runCli(
          [
            "run",
            "start",
            "--state",
            fixture.statePath,
            "--manifest",
            fixture.manifestPath,
            "--repo",
            fixture.repoRoot,
            "--run-id",
            "runtime-cli-start-failure",
          ],
          createBundledStartDependencies(fixture.binding, runtime),
        ),
      ),
    ).rejects.toThrow("runtime startup failed");

    expect({ ensureCalls, stopCalls }).toEqual({ ensureCalls: 1, stopCalls: 0 });
    const store = new SheltieStore(join(fixture.statePath, "state.sqlite"));
    try {
      expect(store.getOnlyTree()).toMatchObject({
        runId: "runtime-cli-start-failure",
        status: "initializing",
        runtimeBinding: fixture.binding,
      });
    } finally {
      store.close();
    }
  });
});
