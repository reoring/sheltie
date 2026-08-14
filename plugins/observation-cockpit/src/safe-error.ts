/**
 * Safe error surface for the Sheltie Observation Cockpit.
 *
 * Every user-visible failure maps to one of these fixed messages. Messages are
 * constants with no interpolation, so raw stderr, state paths, sockets, prompts,
 * Agent identity, and raw payloads are structurally impossible to relay.
 */

export type CockpitErrorCode =
  | "state-dir-missing"
  | "spawn-failed"
  | "command-failed"
  | "timeout"
  | "output-too-large"
  | "invalid-json"
  | "unsupported-version"
  | "invalid-snapshot"
  | "auto-refresh-invalid";

export interface CockpitError {
  readonly kind: "cockpit-error";
  readonly code: CockpitErrorCode;
  readonly message: string;
}

export const COCKPIT_ERROR_MESSAGES: Readonly<Record<CockpitErrorCode, string>> = {
  "state-dir-missing":
    "SHELTIE_STATE_DIR is not set. Reopen this pane with the run state directory configured.",
  "spawn-failed":
    "Could not start the sheltie snapshot command. Check that the executable is installed and on PATH.",
  "command-failed":
    "The snapshot command reported an error. The run state may be missing, locked, or unsupported.",
  timeout: "The snapshot command did not finish in time.",
  "output-too-large": "The snapshot output exceeded the safe size limit and was discarded.",
  "invalid-json": "The snapshot output was not a valid JSON document.",
  "unsupported-version":
    "The snapshot uses an unsupported schema version. Update the cockpit plugin or sheltie.",
  "invalid-snapshot": "The snapshot document failed integrity checks and was not displayed.",
  "auto-refresh-invalid":
    "SHELTIE_AUTO_REFRESH_MS is invalid. Set 0 to disable auto refresh or a whole number of milliseconds between 500 and 30000.",
};

export function cockpitError(code: CockpitErrorCode): CockpitError {
  return { kind: "cockpit-error", code, message: COCKPIT_ERROR_MESSAGES[code] };
}

export function isCockpitError(value: unknown): value is CockpitError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "cockpit-error"
  );
}
