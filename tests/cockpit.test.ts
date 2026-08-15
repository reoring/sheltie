import { describe, expect, test } from "bun:test";
import {
  ATTENTION_HEADING,
  renderCockpit,
  ROLE_GRAPH_HEADING,
  RUNTIME_TREE_HEADING,
  type CockpitViewState,
} from "../plugins/observation-cockpit/src/render.ts";
import {
  AutoRefreshScheduler,
  type TimerAdapter,
} from "../plugins/observation-cockpit/src/auto-refresh.ts";
import { COCKPIT_ERROR_MESSAGES, cockpitError, isCockpitError } from "../plugins/observation-cockpit/src/safe-error.ts";
import {
  decodeObservationSnapshot,
  OBSERVATION_API_VERSION,
  OBSERVATION_KIND,
  type ObservationSnapshot,
} from "../plugins/observation-cockpit/src/snapshot.ts";
import {
  DEFAULT_AUTO_REFRESH_MS,
  DEFAULT_SHELTIE_EXECUTABLE,
  mapSnapshotOutcome,
  MAX_AUTO_REFRESH_MS,
  MIN_AUTO_REFRESH_MS,
  readCockpitConfig,
  snapshotArgv,
  terminateWithEscalation,
  type KillableProcess,
} from "../plugins/observation-cockpit/src/subprocess.ts";

const DENYLIST_MARKERS = [
  "SECRET-MESSAGE-BODY",
  "/absolute/state/dir",
  "herdr-socket.sock",
  "PROMPT-CONTENT-MARKER",
  "agent-identity-marker",
  "raw-operation-payload",
];

interface FixtureDocument {
  [key: string]: unknown;
  apiVersion: string;
  kind: string;
  run: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

function nodeAt(document: FixtureDocument, index: number): Record<string, unknown> {
  const node = document.nodes[index];
  if (node === undefined) throw new Error(`fixture has no node ${index}`);
  return node;
}

function fixtureDocument(): FixtureDocument {
  return {
    apiVersion: OBSERVATION_API_VERSION,
    kind: OBSERVATION_KIND,
    observedAt: "2026-08-14T00:00:00.000Z",
    run: {
      treeId: "tree-1111",
      runId: "run-2222",
      status: "active",
      generation: 3,
      manifestDigest: "abcdef0123456789",
      rootRole: "coordinator",
      baseCommit: "9d31f2ab77aa00ff",
    },
    manifest: {
      apiVersion: "sheltie.dev/v1alpha1",
      name: "manifest-poc",
      digest: "abcdef0123456789",
      root: { name: "root", role: "coordinator" },
      limits: { maxDepth: 3, maxChildrenPerNode: 4, maxDescendants: 16, maxParallelNodes: 4 },
      roles: [
        {
          name: "coordinator",
          digest: "role-digest-coord",
          placement: "workspace",
          allowedChildRoles: ["worker", "reviewer"],
          mergeChildren: true,
          messaging: { sendTo: ["children"], receiveFrom: ["children"] },
          workspaceMode: "read-write",
        },
        {
          name: "worker",
          digest: "role-digest-worker",
          placement: "pane",
          allowedChildRoles: [],
          mergeChildren: false,
          messaging: { sendTo: ["parent"], receiveFrom: ["parent"] },
          workspaceMode: "read-only",
        },
        {
          name: "reviewer",
          digest: "role-digest-reviewer",
          placement: "pane",
          allowedChildRoles: [],
          mergeChildren: false,
          messaging: { sendTo: [], receiveFrom: [] },
          workspaceMode: "read-only",
        },
      ],
    },
    nodes: [
      {
        nodeId: "node-root",
        parentNodeId: null,
        name: "root",
        depth: 0,
        placement: "workspace",
        lifecycleStatus: "running",
        roleName: "coordinator",
        roleDigest: "role-digest-coord",
        generation: 3,
      },
      {
        nodeId: "node-alpha",
        parentNodeId: "node-root",
        name: "alpha",
        depth: 1,
        placement: "pane",
        lifecycleStatus: "completed",
        roleName: "worker",
        roleDigest: "role-digest-worker",
        generation: 1,
      },
      {
        nodeId: "node-beta",
        parentNodeId: "node-root",
        name: "beta",
        depth: 1,
        placement: "pane",
        lifecycleStatus: "failed",
        roleName: "reviewer",
        roleDigest: "role-digest-reviewer",
        generation: 1,
      },
    ],
    edges: [
      { fromNodeId: "node-root", toNodeId: "node-alpha", kind: "logical-parent" },
      { fromNodeId: "node-root", toNodeId: "node-beta", kind: "logical-parent" },
    ],
    summary: {
      nodeLifecycleCounts: { running: 1, completed: 1, failed: 1 },
      unresolvedOperationCounts: { "spawn/pending": 1 },
      stepStatusCounts: { prompted: 2 },
      messageCounts: { "task/unread": 2 },
    },
  };
}

function decodeFixture(mutate?: (document: FixtureDocument) => void): ObservationSnapshot {
  const document = fixtureDocument();
  mutate?.(document);
  const decoded = decodeObservationSnapshot(JSON.stringify(document));
  if (isCockpitError(decoded)) throw new Error(`expected snapshot, got error ${decoded.code}`);
  return decoded;
}

function decodeError(mutate: (document: FixtureDocument) => void): string {
  const document = fixtureDocument();
  mutate(document);
  const decoded = decodeObservationSnapshot(JSON.stringify(document));
  if (!isCockpitError(decoded)) throw new Error("expected decode failure");
  return decoded.code;
}

describe("decodeObservationSnapshot", () => {
  test("decodes an allowlisted document", () => {
    const snapshot = decodeFixture();
    expect(snapshot.run).toEqual({
      treeId: "tree-1111",
      runId: "run-2222",
      status: "active",
      generation: 3,
      manifestDigest: "abcdef0123456789",
      rootRole: "coordinator",
      baseCommit: "9d31f2ab77aa00ff",
    });
    expect(snapshot.manifest.roles.map((role) => role.name)).toEqual([
      "coordinator",
      "worker",
      "reviewer",
    ]);
    expect(snapshot.nodes).toHaveLength(3);
    expect(snapshot.edges).toEqual([
      { fromNodeId: "node-root", toNodeId: "node-alpha", kind: "logical-parent" },
      { fromNodeId: "node-root", toNodeId: "node-beta", kind: "logical-parent" },
    ]);
    expect(snapshot.summary.messageCounts).toEqual({ "task/unread": 2 });
  });

  test("never copies unknown or denylisted input fields", () => {
    const snapshot = decodeFixture((document) => {
      document.messageBody = "SECRET-MESSAGE-BODY";
      document.statePath = "/absolute/state/dir";
      document.run.socketPath = "herdr-socket.sock";
      document.run.prompt = "PROMPT-CONTENT-MARKER";
      for (const node of document.nodes) {
        node.agentSession = "agent-identity-marker";
        node.operationRequest = "raw-operation-payload";
      }
    });
    const serialized = JSON.stringify(snapshot);
    for (const marker of DENYLIST_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
  });

  test("rejects invalid JSON", () => {
    const decoded = decodeObservationSnapshot("{not json");
    expect(isCockpitError(decoded) && decoded.code).toBe("invalid-json");
  });

  test("rejects unknown apiVersion and kind without echoing them", () => {
    expect(decodeError((document) => {
      document.apiVersion = "sheltie.dev/observation/v9";
    })).toBe("unsupported-version");
    expect(decodeError((document) => {
      document.kind = "SomethingElse";
    })).toBe("unsupported-version");
    const decoded = decodeObservationSnapshot(
      JSON.stringify({ apiVersion: "sheltie.dev/observation/v9", kind: OBSERVATION_KIND }),
    );
    if (!isCockpitError(decoded)) throw new Error("expected error");
    expect(decoded.message).not.toContain("v9");
  });

  test("fails closed when an edge references a missing node", () => {
    expect(decodeError((document) => {
      document.edges.push({ fromNodeId: "node-root", toNodeId: "node-ghost", kind: "logical-parent" });
    })).toBe("invalid-snapshot");
  });

  test("fails closed on duplicate incoming edges", () => {
    expect(decodeError((document) => {
      document.edges.push({ fromNodeId: "node-beta", toNodeId: "node-alpha", kind: "logical-parent" });
    })).toBe("invalid-snapshot");
  });

  test("fails closed when edges disagree with parentNodeId", () => {
    expect(decodeError((document) => {
      document.edges.splice(1, 1);
    })).toBe("invalid-snapshot");
  });

  test("fails closed without exactly one root", () => {
    expect(decodeError((document) => {
      nodeAt(document, 2).parentNodeId = null;
      document.edges.splice(1, 1);
    })).toBe("invalid-snapshot");
  });

  test("fails closed on depth inconsistency", () => {
    expect(decodeError((document) => {
      nodeAt(document, 1).depth = 2;
    })).toBe("invalid-snapshot");
  });

  test("fails closed when a node references an unknown role", () => {
    expect(decodeError((document) => {
      nodeAt(document, 1).roleName = "ghost-role";
    })).toBe("invalid-snapshot");
  });

  test("fails closed when an edge kind is not logical-parent", () => {
    expect(decodeError((document) => {
      const first = document.edges[0];
      if (first === undefined) throw new Error("fixture has no edges");
      first.kind = "workspace-order";
    })).toBe("invalid-snapshot");
  });
});

describe("safe errors", () => {
  test("messages are fixed and free of denylisted content", () => {
    for (const message of Object.values(COCKPIT_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/\/[a-z]/i);
      for (const marker of DENYLIST_MARKERS) expect(message).not.toContain(marker);
    }
  });
});

describe("subprocess contract", () => {
  test("argv is exact and shell-free", () => {
    expect(snapshotArgv("sheltie", "STATE_DIR")).toEqual([
      "sheltie",
      "observe",
      "snapshot",
      "--state",
      "STATE_DIR",
    ]);
  });

  test("config requires SHELTIE_STATE_DIR and defaults the executable", () => {
    const missing = readCockpitConfig({});
    expect(isCockpitError(missing) && missing.code).toBe("state-dir-missing");
    const defaulted = readCockpitConfig({ SHELTIE_STATE_DIR: "some-state" });
    if (isCockpitError(defaulted)) throw new Error("expected config");
    expect(defaulted).toEqual({
      stateDir: "some-state",
      executable: DEFAULT_SHELTIE_EXECUTABLE,
      autoRefreshMs: DEFAULT_AUTO_REFRESH_MS,
      autoRefreshEnabled: true,
    });
    const custom = readCockpitConfig({
      SHELTIE_STATE_DIR: "some-state",
      SHELTIE_EXECUTABLE: "sheltie-dev",
    });
    if (isCockpitError(custom)) throw new Error("expected config");
    expect(custom.executable).toBe("sheltie-dev");
  });

  test("auto refresh env: default on, strict override, 0 disables", () => {
    const base = { SHELTIE_STATE_DIR: "some-state" };
    const blank = readCockpitConfig({ ...base, SHELTIE_AUTO_REFRESH_MS: "  " });
    if (isCockpitError(blank)) throw new Error("expected config");
    expect(blank.autoRefreshEnabled).toBe(true);
    expect(blank.autoRefreshMs).toBe(DEFAULT_AUTO_REFRESH_MS);
    const overridden = readCockpitConfig({ ...base, SHELTIE_AUTO_REFRESH_MS: "5000" });
    if (isCockpitError(overridden)) throw new Error("expected config");
    expect(overridden.autoRefreshEnabled).toBe(true);
    expect(overridden.autoRefreshMs).toBe(5000);
    const bounds = readCockpitConfig({
      ...base,
      SHELTIE_AUTO_REFRESH_MS: String(MIN_AUTO_REFRESH_MS),
    });
    if (isCockpitError(bounds)) throw new Error("expected config");
    expect(bounds.autoRefreshMs).toBe(MIN_AUTO_REFRESH_MS);
    const disabled = readCockpitConfig({ ...base, SHELTIE_AUTO_REFRESH_MS: "0" });
    if (isCockpitError(disabled)) throw new Error("expected config");
    expect(disabled.autoRefreshEnabled).toBe(false);
    // Toggling on later uses the default cadence, not a zero interval.
    expect(disabled.autoRefreshMs).toBe(DEFAULT_AUTO_REFRESH_MS);
  });

  test("auto refresh env fails closed on malformed or out-of-range values", () => {
    const base = { SHELTIE_STATE_DIR: "some-state" };
    const invalid = [
      "abc",
      "-1",
      "1.5",
      "2e3",
      String(MIN_AUTO_REFRESH_MS - 1),
      String(MAX_AUTO_REFRESH_MS + 1),
    ];
    for (const value of invalid) {
      const config = readCockpitConfig({ ...base, SHELTIE_AUTO_REFRESH_MS: value });
      expect(isCockpitError(config) && config.code).toBe("auto-refresh-invalid");
    }
  });

  test("maps command failures to safe errors without relaying output", () => {
    const timeout = mapSnapshotOutcome({ timedOut: true, oversized: false, exitCode: null, stdout: "" });
    expect(isCockpitError(timeout) && timeout.code).toBe("timeout");
    const oversized = mapSnapshotOutcome({ timedOut: false, oversized: true, exitCode: null, stdout: "" });
    expect(isCockpitError(oversized) && oversized.code).toBe("output-too-large");
    const failed = mapSnapshotOutcome({
      timedOut: false,
      oversized: false,
      exitCode: 3,
      stdout: "stderr-like detail /absolute/state/dir",
    });
    if (!isCockpitError(failed)) throw new Error("expected error");
    expect(failed.code).toBe("command-failed");
    expect(failed.message).not.toContain("/absolute/state/dir");
    expect(failed.message).not.toContain("stderr-like");
  });

  test("maps a successful outcome through the decoder", () => {
    const decoded = mapSnapshotOutcome({
      timedOut: false,
      oversized: false,
      exitCode: 0,
      stdout: JSON.stringify(fixtureDocument()),
    });
    if (isCockpitError(decoded)) throw new Error(`expected snapshot, got ${decoded.code}`);
    expect(decoded.run.runId).toBe("run-2222");
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const signals: string[] = [];
    let resolveExit: (code: number) => void = () => {};
    const proc: KillableProcess = {
      kill(signal) {
        signals.push(signal);
        // Simulates a child that ignores SIGTERM: only SIGKILL settles exited.
        if (signal === "SIGKILL") resolveExit(137);
      },
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
    };
    const outcome = await terminateWithEscalation(proc, 5);
    expect(outcome).toBe("killed");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("does not SIGKILL a child that exits within the grace period", async () => {
    const signals: string[] = [];
    let resolveExit: (code: number) => void = () => {};
    const proc: KillableProcess = {
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGTERM") resolveExit(0);
      },
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
    };
    const outcome = await terminateWithEscalation(proc, 5);
    expect(outcome).toBe("exited");
    expect(signals).toEqual(["SIGTERM"]);
  });
});

function view(partial: Partial<CockpitViewState>): CockpitViewState {
  return {
    phase: "ready",
    snapshot: null,
    error: null,
    lastRefreshAt: null,
    refreshing: false,
    autoRefreshEnabled: true,
    autoRefreshMs: 2000,
    ...partial,
  };
}

const WIDE = { color: false, maxWidth: 200 } as const;

describe("renderCockpit", () => {
  test("compact layout: header, runtime tree first, roles, attention", () => {
    const snapshot = decodeFixture();
    const lines = renderCockpit(view({ snapshot, lastRefreshAt: "00:00:00Z" }), WIDE);
    const text = lines.join("\n");

    const runtimeIndex = lines.findIndex((line) => line.includes(RUNTIME_TREE_HEADING));
    const roleIndex = lines.findIndex((line) => line.includes(ROLE_GRAPH_HEADING));
    const attentionIndex = lines.findIndex((line) => line.includes(ATTENTION_HEADING));
    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(roleIndex).toBeGreaterThan(runtimeIndex);
    expect(attentionIndex).toBeGreaterThan(roleIndex);

    // Compact header: run id, status, completed/total progress, refresh time.
    expect(text).toContain("run-2222  active  1/3 done  refreshed 00:00:00Z");
    // Header hides tree id, digests, and base commit by default.
    expect(text).not.toContain("tree-1111");
    expect(text).not.toContain("abcdef0123");
    expect(text).not.toContain("9d31f2ab");

    // Runtime tree: glyph, name, role — glyphs carry meaning without color.
    expect(text).toContain("\u25cf root (coordinator)");
    expect(text).toContain("+- \u2713 alpha (worker)");
    expect(text).toContain("`- \u00d7 beta (reviewer)");
  });

  test("role graph is one compact line per role, root first", () => {
    const snapshot = decodeFixture();
    const lines = renderCockpit(view({ snapshot }), WIDE);
    const text = lines.join("\n");
    expect(text).toContain("* coordinator \u2192 worker, reviewer [workspace, merge]");
    expect(text).toContain("- reviewer [pane]");
    expect(text).toContain("- worker [pane]");
    // Verbose spawn/messaging lines are gone from the default view.
    expect(text).not.toContain("spawns ->");
    expect(text).not.toContain("messaging");
    const coordinatorIndex = lines.findIndex((line) => line.startsWith("* coordinator"));
    const reviewerIndex = lines.findIndex((line) => line.startsWith("- reviewer"));
    expect(coordinatorIndex).toBeGreaterThan(-1);
    expect(reviewerIndex).toBeGreaterThan(coordinatorIndex);
  });

  test("attention renders only non-zero counters", () => {
    const snapshot = decodeFixture((document) => {
      document.summary = {
        nodeLifecycleCounts: { running: 1, completed: 0, failed: 2 },
        unresolvedOperationCounts: {},
        stepStatusCounts: { prompted: 0 },
        messageCounts: { "task/unread": 2 },
      };
    });
    const text = renderCockpit(view({ snapshot }), WIDE).join("\n");
    expect(text).toContain("failed=2");
    expect(text).toContain("running=1");
    expect(text).toContain("task/unread=2");
    // Zero-valued statuses and empty categories never render.
    expect(text).not.toContain("completed=0");
    expect(text).not.toContain("prompted=0");
    expect(text).not.toMatch(/^steps/m);
    expect(text).not.toMatch(/^operations/m);
  });

  test("clips every line to maxWidth instead of wrapping", () => {
    const snapshot = decodeFixture();
    for (const color of [false, true]) {
      const lines = renderCockpit(view({ snapshot, lastRefreshAt: "00:00:00Z" }), {
        color,
        maxWidth: 24,
      });
      for (const line of lines) {
        const visible = line.replaceAll(/\x1b\[[0-9;]*m/g, "");
        expect(visible.length).toBeLessThanOrEqual(24);
      }
    }
    const title = renderCockpit(view({ snapshot }), { color: false, maxWidth: 10 })[0];
    expect(title).toBe("Sheltie Ob");
  });

  test("keeps node ids off the screen and works without color", () => {
    const snapshot = decodeFixture();
    const text = renderCockpit(view({ snapshot }), WIDE).join("\n");
    expect(text).not.toContain("node-root");
    expect(text).not.toContain("node-alpha");
    expect(text).not.toContain("\x1b[");
  });

  test("colored output only decorates the same text", () => {
    const snapshot = decodeFixture();
    const state = view({ snapshot });
    const plain = renderCockpit(state, WIDE).join("\n");
    const colored = renderCockpit(state, { color: true, maxWidth: 200 })
      .join("\n")
      .replaceAll(/\x1b\[[0-9;]*m/g, "");
    expect(colored).toBe(plain);
  });

  test("footer shows auto refresh state and cadence", () => {
    const snapshot = decodeFixture();
    const on = renderCockpit(view({ snapshot }), WIDE).join("\n");
    expect(on).toContain("[r] refresh   [a] auto:on 2.0s   [q] quit");
    const slow = renderCockpit(view({ snapshot, autoRefreshMs: 5000 }), WIDE).join("\n");
    expect(slow).toContain("[a] auto:on 5.0s");
    const off = renderCockpit(view({ snapshot, autoRefreshEnabled: false }), WIDE).join("\n");
    expect(off).toContain("[r] refresh   [a] auto:off   [q] quit");
    const busy = renderCockpit(view({ snapshot, refreshing: true }), WIDE).join("\n");
    expect(busy).toContain("refreshing...");
  });

  test("error state shows only the fixed safe message", () => {
    const lines = renderCockpit(
      view({ phase: "error", error: cockpitError("command-failed") }),
      WIDE,
    );
    const text = lines.join("\n");
    expect(text).toContain(COCKPIT_ERROR_MESSAGES["command-failed"]);
    expect(text).toContain("[r] refresh");
    expect(text).toContain("[q] quit");
    for (const marker of DENYLIST_MARKERS) expect(text).not.toContain(marker);
  });
});

interface PendingTimer {
  readonly id: number;
  readonly ms: number;
  readonly callback: () => void;
}

class FakeTimers implements TimerAdapter {
  #nextId = 1;
  pending: PendingTimer[] = [];

  set(callback: () => void, ms: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.pending.push({ id, ms, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.pending = this.pending.filter((timer) => timer.id !== handle);
  }

  fire(): void {
    const timer = this.pending.shift();
    if (timer === undefined) throw new Error("no pending timer to fire");
    timer.callback();
  }
}

interface DeferredVoid {
  promise: Promise<void>;
  resolve(value?: void | PromiseLike<void>): void;
  reject(reason?: unknown): void;
}

describe("AutoRefreshScheduler", () => {
  function harness(enabled = true) {
    const timers = new FakeTimers();
    // Each run is a promise the test settles; the scheduler's own `await`
    // reaction is registered before the test's, so `await runs[n].promise`
    // resolves strictly after the scheduler's completion path has executed.
    const runs: DeferredVoid[] = [];
    const scheduler = new AutoRefreshScheduler({
      intervalMs: 2000,
      enabled,
      run: () => {
        const pending = Promise.withResolvers<void>();
        runs.push(pending);
        return pending.promise;
      },
      timers,
    });
    return { timers, scheduler, runs };
  }

  test("arms one tick at the interval and never overlaps runs", async () => {
    const { timers, scheduler, runs } = harness();
    scheduler.armNext();
    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0]?.ms).toBe(2000);
    // armNext while armed is a no-op: still exactly one pending tick.
    scheduler.armNext();
    expect(timers.pending).toHaveLength(1);

    timers.fire();
    expect(runs).toHaveLength(1);
    // While the refresh is in flight, nothing is armed and nothing overlaps.
    expect(timers.pending).toHaveLength(0);

    runs[0]?.resolve();
    await runs[0]?.promise;
    // Re-armed only after completion, and no extra run was started.
    expect(timers.pending).toHaveLength(1);
    expect(runs).toHaveLength(1);
  });

  test("toggle off clears the pending tick; toggle on re-arms", () => {
    const { timers, scheduler } = harness();
    scheduler.armNext();
    expect(timers.pending).toHaveLength(1);
    expect(scheduler.toggle()).toBe(false);
    expect(timers.pending).toHaveLength(0);
    expect(scheduler.toggle()).toBe(true);
    expect(timers.pending).toHaveLength(1);
  });

  test("does not arm when disabled", () => {
    const { timers, scheduler } = harness(false);
    scheduler.armNext();
    expect(timers.pending).toHaveLength(0);
  });

  test("re-arms after a failing refresh so auto refresh recovers", async () => {
    const { timers, scheduler, runs } = harness();
    scheduler.armNext();
    timers.fire();
    runs[0]?.reject(new Error("refresh failed"));
    await runs[0]?.promise.catch(() => {});
    expect(timers.pending).toHaveLength(1);
  });

  test("toggle off during an in-flight refresh suppresses the re-arm", async () => {
    const { timers, scheduler, runs } = harness();
    scheduler.armNext();
    timers.fire();
    scheduler.toggle();
    runs[0]?.resolve();
    await runs[0]?.promise;
    expect(timers.pending).toHaveLength(0);
  });

  test("off-then-on during a refresh keeps exactly one pending tick", async () => {
    const { timers, scheduler, runs } = harness();
    scheduler.armNext();
    timers.fire();
    scheduler.toggle();
    scheduler.toggle();
    expect(timers.pending).toHaveLength(1);
    runs[0]?.resolve();
    await runs[0]?.promise;
    // The completion path must not double-arm on top of the toggle's tick.
    expect(timers.pending).toHaveLength(1);
  });

  test("stop disables and clears the pending tick", () => {
    const { timers, scheduler } = harness();
    scheduler.armNext();
    scheduler.stop();
    expect(timers.pending).toHaveLength(0);
    expect(scheduler.enabled).toBe(false);
    scheduler.armNext();
    expect(timers.pending).toHaveLength(0);
  });
});
