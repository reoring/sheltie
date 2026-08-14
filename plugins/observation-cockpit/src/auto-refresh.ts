/**
 * Completion-chained auto refresh scheduler for the cockpit pane.
 *
 * Instead of a fixed `setInterval` (which can stack refreshes behind a slow
 * snapshot command), at most one timeout is armed at a time and the next one
 * is armed only after the current refresh settles — success or failure. The
 * `run` callback is expected to join any in-flight refresh, so a tick that
 * lands during a manual refresh waits for it and then re-arms instead of
 * spawning a second subprocess. Timers are injected so tests stay
 * deterministic without real clocks.
 */

export interface TimerAdapter {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: TimerAdapter = {
  set: (callback, ms) => setTimeout(callback, ms),
  // The handle is opaque to the scheduler and only round-trips back into
  // clearTimeout, which tolerates any handle it produced.
  clear: (handle) => clearTimeout(handle as never),
};

export interface AutoRefreshOptions {
  readonly intervalMs: number;
  /** Initial enabled state; arming still requires an explicit armNext(). */
  readonly enabled: boolean;
  /** Runs one refresh; resolves when the refresh has fully settled. */
  readonly run: () => Promise<void>;
  readonly timers?: TimerAdapter;
}

export class AutoRefreshScheduler {
  readonly #intervalMs: number;
  readonly #run: () => Promise<void>;
  readonly #timers: TimerAdapter;
  #enabled: boolean;
  #handle: unknown = null;

  constructor(options: AutoRefreshOptions) {
    this.#intervalMs = options.intervalMs;
    this.#run = options.run;
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#enabled = options.enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Arm the next tick if enabled and none is pending. Safe to call anytime. */
  armNext(): void {
    if (!this.#enabled || this.#handle !== null) return;
    this.#handle = this.#timers.set(() => {
      void this.#tick();
    }, this.#intervalMs);
  }

  /** Flip auto refresh; off clears the pending tick, on arms the next one. */
  toggle(): boolean {
    this.#enabled = !this.#enabled;
    if (this.#enabled) this.armNext();
    else this.#clear();
    return this.#enabled;
  }

  /** Disable and clear any pending tick. Used on shutdown. */
  stop(): void {
    this.#enabled = false;
    this.#clear();
  }

  #clear(): void {
    if (this.#handle === null) return;
    this.#timers.clear(this.#handle);
    this.#handle = null;
  }

  async #tick(): Promise<void> {
    this.#handle = null;
    try {
      await this.#run();
    } catch {
      // The refresh path reports failures through view state; a rejection
      // must still re-arm so auto refresh recovers after an error.
    } finally {
      // armNext() re-checks enabled and pending state, so a toggle-off (or
      // off-then-on, which armed its own tick) during the refresh wins.
      this.armNext();
    }
  }
}
