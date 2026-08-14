/**
 * Pure, deterministic renderer for the cockpit pane.
 *
 * Layout is compact and scan-first: a one-line header (run, status,
 * completed/total progress, refresh time), the runtime instance tree as the
 * primary section, a one-line-per-role graph, then an attention section that
 * only lists non-zero counters. Status glyphs carry meaning without color;
 * ANSI color is optional decoration on top of the same text. Every line is
 * clipped to the caller's width — never wrapped by the terminal. Node ids are
 * used solely to resolve edges; the visible tree shows glyph, name, and role.
 */

import type { CockpitError } from "./safe-error.ts";
import type { ObservationSnapshot, SnapshotNode, SnapshotRole } from "./snapshot.ts";

export interface RenderOptions {
  readonly color: boolean;
  /** Hard cap on visible characters per line; longer lines are clipped. */
  readonly maxWidth: number;
}

export interface CockpitViewState {
  phase: "loading" | "ready" | "error";
  snapshot: ObservationSnapshot | null;
  error: CockpitError | null;
  lastRefreshAt: string | null;
  refreshing: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshMs: number;
}

export const RUNTIME_TREE_HEADING = "Runtime";
export const ROLE_GRAPH_HEADING = "Roles";
export const ATTENTION_HEADING = "Attention";

const RESET = "\x1b[0m";
const ESC = "\x1b";

/**
 * Glyphs spell out status without color: done, running, waiting, needs
 * attention, failed. Unknown statuses render as "?" so they stay visible.
 */
const STATUS_GLYPHS: Readonly<Record<string, string>> = {
  completed: "\u2713",
  observed: "\u2713",
  merged: "\u2713",
  running: "\u25cf",
  active: "\u25cf",
  pending: "\u25cb",
  spawning: "\u25cb",
  blocked: "!",
  cancelling: "!",
  cancelled: "!",
  quiesced: "!",
  delivery_unknown: "!",
  failed: "\u00d7",
};

/** Statuses counted as done in the header progress fraction. */
const DONE_STATUSES = new Set(["completed", "observed", "merged"]);

const STATUS_SGR: Record<string, string> = {
  active: "32",
  running: "32",
  completed: "36",
  observed: "36",
  merged: "36",
  pending: "33",
  spawning: "33",
  blocked: "33",
  cancelling: "33",
  cancelled: "33",
  quiesced: "33",
  failed: "31",
  delivery_unknown: "31",
};

function paint(text: string, sgr: string, color: boolean): string {
  return color ? `${ESC}[${sgr}m${text}${RESET}` : text;
}

function paintStatus(status: string, color: boolean): string {
  const sgr = STATUS_SGR[status];
  return sgr === undefined ? status : paint(status, sgr, color);
}

function statusGlyph(status: string, color: boolean): string {
  const glyph = STATUS_GLYPHS[status] ?? "?";
  const sgr = STATUS_SGR[status];
  return sgr === undefined ? glyph : paint(glyph, sgr, color);
}

function heading(title: string, color: boolean): string {
  return paint(`-- ${title} --`, "1", color);
}

function headerLine(
  snapshot: ObservationSnapshot,
  lastRefreshAt: string | null,
  color: boolean,
): string {
  const done = snapshot.nodes.filter((node) => DONE_STATUSES.has(node.lifecycleStatus)).length;
  const parts = [
    paint(snapshot.run.runId, "1", color),
    paintStatus(snapshot.run.status, color),
    `${done}/${snapshot.nodes.length} done`,
  ];
  if (lastRefreshAt !== null) parts.push(`refreshed ${lastRefreshAt}`);
  return parts.join("  ");
}

/** One compact line per role: `* coordinator → worker, reviewer [workspace, merge]`. */
function roleGraphLines(snapshot: ObservationSnapshot, color: boolean): string[] {
  const rootRole = snapshot.run.rootRole;
  const roles = [...snapshot.manifest.roles].sort((left, right) => {
    if (left.name === rootRole) return -1;
    if (right.name === rootRole) return 1;
    return left.name.localeCompare(right.name);
  });
  return roles.map((role) => roleLine(role, role.name === rootRole, color));
}

function roleLine(role: SnapshotRole, isRoot: boolean, color: boolean): string {
  const traits = [role.placement];
  if (role.mergeChildren) traits.push("merge");
  const spawns =
    role.allowedChildRoles.length === 0 ? "" : ` \u2192 ${role.allowedChildRoles.join(", ")}`;
  return `${isRoot ? "*" : "-"} ${paint(role.name, "1", color)}${spawns} [${traits.join(", ")}]`;
}

function nodeLabel(node: SnapshotNode, color: boolean): string {
  return `${statusGlyph(node.lifecycleStatus, color)} ${node.name} (${node.roleName})`;
}

/**
 * Draws the runtime tree from snapshot edges only. The decoder has already
 * proven single-root, acyclic, depth-consistent edges; this walk just lays
 * them out. Children are ordered by name then nodeId for determinism.
 */
function runtimeTreeLines(snapshot: ObservationSnapshot, color: boolean): string[] {
  const nodesById = new Map<string, SnapshotNode>();
  for (const node of snapshot.nodes) nodesById.set(node.nodeId, node);
  const childrenByParent = new Map<string, SnapshotNode[]>();
  const childIds = new Set<string>();
  for (const edge of snapshot.edges) {
    childIds.add(edge.toNodeId);
    const child = nodesById.get(edge.toNodeId);
    if (child === undefined) continue;
    const siblings = childrenByParent.get(edge.fromNodeId);
    if (siblings === undefined) childrenByParent.set(edge.fromNodeId, [child]);
    else siblings.push(child);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(
      (left, right) => left.name.localeCompare(right.name) || left.nodeId.localeCompare(right.nodeId),
    );
  }
  const root = snapshot.nodes.find((node) => !childIds.has(node.nodeId));
  if (root === undefined) return ["(runtime tree unavailable)"];

  const lines: string[] = [nodeLabel(root, color)];
  const walk = (parent: SnapshotNode, prefix: string): void => {
    const children = childrenByParent.get(parent.nodeId) ?? [];
    children.forEach((child, index) => {
      const last = index === children.length - 1;
      lines.push(`${prefix}${last ? "`- " : "+- "}${nodeLabel(child, color)}`);
      walk(child, `${prefix}${last ? "   " : "|  "}`);
    });
  };
  walk(root, "");
  return lines;
}

/** Non-zero counters only; zero-valued statuses are never rendered. */
function attentionLines(snapshot: ObservationSnapshot): string[] {
  const categories: [string, Readonly<Record<string, number>>][] = [
    ["nodes", snapshot.summary.nodeLifecycleCounts],
    ["operations", snapshot.summary.unresolvedOperationCounts],
    ["steps", snapshot.summary.stepStatusCounts],
    ["messages", snapshot.summary.messageCounts],
  ];
  const lines: string[] = [];
  for (const [label, counts] of categories) {
    const entries = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => `${key}=${count}`);
    if (entries.length > 0) lines.push(`${label.padEnd(12)}${entries.join("  ")}`);
  }
  return lines.length === 0 ? ["(none)"] : lines;
}

function snapshotLines(
  snapshot: ObservationSnapshot,
  lastRefreshAt: string | null,
  color: boolean,
): string[] {
  return [
    headerLine(snapshot, lastRefreshAt, color),
    "",
    heading(RUNTIME_TREE_HEADING, color),
    ...runtimeTreeLines(snapshot, color),
    "",
    heading(ROLE_GRAPH_HEADING, color),
    ...roleGraphLines(snapshot, color),
    "",
    heading(ATTENTION_HEADING, color),
    ...attentionLines(snapshot),
  ];
}

/**
 * Clip one line to `maxWidth` visible characters. SGR escape sequences are
 * copied without counting; a clipped line that carried any escapes gets a
 * trailing reset so color state never leaks past the clip point.
 */
function clipLine(line: string, maxWidth: number): string {
  if (!line.includes(ESC) && line.length <= maxWidth) return line;
  let out = "";
  let visible = 0;
  let sawEscape = false;
  let index = 0;
  while (index < line.length) {
    if (line[index] === ESC && line[index + 1] === "[") {
      let end = index + 2;
      while (end < line.length && line[end] !== "m") end += 1;
      out += line.slice(index, end + 1);
      sawEscape = true;
      index = end + 1;
      continue;
    }
    if (visible >= maxWidth) return sawEscape ? `${out}${RESET}` : out;
    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    out += char;
    visible += 1;
    index += char.length;
  }
  return out;
}

/** Render one full frame as clipped lines (no trailing newline handling). */
export function renderCockpit(state: CockpitViewState, options: RenderOptions): string[] {
  const lines: string[] = [paint("Sheltie Observation Cockpit", "1", options.color), ""];
  if (state.phase === "loading") {
    lines.push("Loading snapshot...");
  } else if (state.phase === "error" && state.error !== null) {
    lines.push(paint("Snapshot unavailable.", "31", options.color), "", state.error.message);
  } else if (state.snapshot !== null) {
    lines.push(...snapshotLines(state.snapshot, state.lastRefreshAt, options.color));
  }
  lines.push("");
  const auto = state.autoRefreshEnabled
    ? `[a] auto:on ${(state.autoRefreshMs / 1000).toFixed(1)}s`
    : "[a] auto:off";
  const footer = ["[r] refresh", auto, "[q] quit", state.refreshing ? "refreshing..." : ""]
    .filter((part) => part.length > 0)
    .join("   ");
  lines.push(paint(footer, "2", options.color));
  return lines.map((line) => clipLine(line, options.maxWidth));
}
