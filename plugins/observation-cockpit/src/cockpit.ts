/**
 * Sheltie Observation Cockpit — Herdr Plugin pane entrypoint.
 *
 * Read-only viewer for versioned ObservationSnapshot documents. Refreshes are
 * completion-chained: at most one bounded snapshot subprocess ever runs, and
 * when auto refresh is enabled the next tick is armed only after the previous
 * refresh settles. `r`/`R` refreshes manually (never touching auto state),
 * `a`/`A` toggles auto refresh, and `q`, Escape, or Ctrl-C quits. There is no
 * event subscription, no SQLite access, no Herdr API call, and no mutation
 * path of any kind: the only side effect is the read-only snapshot command.
 */

import { AutoRefreshScheduler } from "./auto-refresh.ts";
import { isCockpitError } from "./safe-error.ts";
import { renderCockpit, type CockpitViewState } from "./render.ts";
import { DEFAULT_AUTO_REFRESH_MS, fetchSnapshot, readCockpitConfig } from "./subprocess.ts";

const CLEAR_AND_HOME = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

async function main(): Promise<void> {
  const config = readCockpitConfig(process.env);
  const state: CockpitViewState = {
    phase: "loading",
    snapshot: null,
    error: null,
    lastRefreshAt: null,
    refreshing: false,
    autoRefreshEnabled: !isCockpitError(config) && config.autoRefreshEnabled,
    autoRefreshMs: isCockpitError(config) ? DEFAULT_AUTO_REFRESH_MS : config.autoRefreshMs,
  };
  if (isCockpitError(config)) {
    state.phase = "error";
    state.error = config;
  }

  const redraw = (): void => {
    const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
    const maxWidth = process.stdout.columns ?? 80;
    const frame = renderCockpit(state, { color, maxWidth }).join("\r\n");
    process.stdout.write(`${CLEAR_AND_HOME}${frame}\r\n`);
  };

  // Joining an in-flight refresh (instead of starting another) is what keeps
  // the subprocess count at most one even when an auto tick lands during a
  // manual refresh: the tick awaits the same promise and re-arms afterwards.
  let inFlight: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (isCockpitError(config)) {
      redraw();
      return Promise.resolve();
    }
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      state.refreshing = true;
      redraw();
      const result = await fetchSnapshot(config);
      state.refreshing = false;
      if (isCockpitError(result)) {
        state.phase = "error";
        state.error = result;
        state.snapshot = null;
      } else {
        state.phase = "ready";
        state.snapshot = result;
        state.error = null;
        // Display-only local clock; the snapshot's own observedAt stays authoritative.
        state.lastRefreshAt = `${new Date().toISOString().slice(11, 19)}Z`;
      }
      redraw();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const scheduler = isCockpitError(config)
    ? null
    : new AutoRefreshScheduler({
        intervalMs: config.autoRefreshMs,
        enabled: config.autoRefreshEnabled,
        run: refresh,
      });

  const shutdown = (): never => {
    scheduler?.stop();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${SHOW_CURSOR}\x1b[0m\r\n`);
    process.exit(0);
  };

  process.stdout.write(HIDE_CURSOR);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    const key = chunk.toString("utf8");
    // A lone ESC byte is the Escape key; longer ESC-prefixed chunks are
    // terminal sequences (arrows, etc.) and are ignored.
    if (key === "q" || key === "Q" || key === "\x1b" || key === "\x03") shutdown();
    if (key === "r" || key === "R") void refresh();
    if ((key === "a" || key === "A") && scheduler !== null) {
      state.autoRefreshEnabled = scheduler.toggle();
      redraw();
    }
  });
  process.stdout.on("resize", redraw);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  redraw();
  await refresh();
  // First auto tick fires one interval after the initial refresh completes;
  // armNext() is a no-op when auto refresh is disabled or already armed via
  // an `a` toggle during the initial load.
  scheduler?.armNext();
}

if (import.meta.main) void main();
