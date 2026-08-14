/**
 * Decoder for `sheltie.dev/observation/v1alpha1` ObservationSnapshot documents.
 *
 * The decoder copies allowlisted fields into fresh objects and never retains
 * the raw parsed document. Unknown fields are ignored (never copied), so
 * denylisted values present in the input cannot reach UI state. Any type
 * mismatch or referential-integrity violation fails closed with a safe error.
 */

import { cockpitError, type CockpitError } from "./safe-error.ts";

export const OBSERVATION_API_VERSION = "sheltie.dev/observation/v1alpha1";
export const OBSERVATION_KIND = "ObservationSnapshot";

export interface SnapshotRun {
  readonly treeId: string;
  readonly runId: string;
  readonly status: string;
  readonly generation: number;
  readonly manifestDigest: string;
  readonly rootRole: string;
  readonly baseCommit: string;
}

export interface SnapshotRoleMessaging {
  readonly sendTo: readonly string[];
  readonly receiveFrom: readonly string[];
}

export interface SnapshotRole {
  readonly name: string;
  readonly digest: string;
  readonly placement: string;
  readonly allowedChildRoles: readonly string[];
  readonly mergeChildren: boolean;
  readonly messaging: SnapshotRoleMessaging;
  readonly workspaceMode: string;
}

export interface SnapshotManifestLimits {
  readonly maxDepth?: number;
  readonly maxChildrenPerNode?: number;
  readonly maxDescendants?: number;
  readonly maxParallelNodes?: number;
}

export interface SnapshotManifestRoot {
  readonly name: string;
  readonly role: string;
}

export interface SnapshotManifest {
  readonly apiVersion: string;
  readonly name: string;
  readonly digest: string;
  readonly root: SnapshotManifestRoot;
  readonly limits: SnapshotManifestLimits;
  readonly roles: readonly SnapshotRole[];
}

export interface SnapshotNode {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly name: string;
  readonly depth: number;
  readonly placement: string;
  readonly lifecycleStatus: string;
  readonly roleName: string;
  readonly roleDigest: string;
  readonly generation: number;
}

export interface SnapshotEdge {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: "logical-parent";
}

export interface SnapshotSummary {
  readonly nodeLifecycleCounts: Readonly<Record<string, number>>;
  readonly unresolvedOperationCounts: Readonly<Record<string, number>>;
  readonly stepStatusCounts: Readonly<Record<string, number>>;
  readonly messageCounts: Readonly<Record<string, number>>;
}

export interface ObservationSnapshot {
  readonly kind: "observation-snapshot";
  readonly observedAt: string;
  readonly run: SnapshotRun;
  readonly manifest: SnapshotManifest;
  readonly nodes: readonly SnapshotNode[];
  readonly edges: readonly SnapshotEdge[];
  readonly summary: SnapshotSummary;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // Safe: typeof/null/Array checks above prove a plain object; property values stay unknown.
  const record = value as Record<string, unknown>;
  return record;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  const text = asString(value);
  return text === null ? undefined : text;
}

function asInt(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    const text = asString(entry);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

function asCountMap(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key.length === 0) return null;
    const count = asInt(entry, 0);
    if (count === null) return null;
    out[key] = count;
  }
  return out;
}

function decodeRun(value: unknown): SnapshotRun | null {
  const record = asRecord(value);
  if (record === null) return null;
  const treeId = asString(record.treeId);
  const runId = asString(record.runId);
  const status = asString(record.status);
  const generation = asInt(record.generation, 0);
  const manifestDigest = asString(record.manifestDigest);
  const rootRole = asString(record.rootRole);
  const baseCommit = asString(record.baseCommit);
  if (
    treeId === null ||
    runId === null ||
    status === null ||
    generation === null ||
    manifestDigest === null ||
    rootRole === null ||
    baseCommit === null
  ) {
    return null;
  }
  return { treeId, runId, status, generation, manifestDigest, rootRole, baseCommit };
}

function decodeMessaging(value: unknown): SnapshotRoleMessaging | null {
  const record = asRecord(value);
  if (record === null) return null;
  const sendTo = asStringArray(record.sendTo);
  const receiveFrom = asStringArray(record.receiveFrom);
  if (sendTo === null || receiveFrom === null) return null;
  return { sendTo, receiveFrom };
}

function decodeRole(value: unknown): SnapshotRole | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asString(record.name);
  const digest = asString(record.digest);
  const placement = asString(record.placement);
  const allowedChildRoles = asStringArray(record.allowedChildRoles);
  const mergeChildren = typeof record.mergeChildren === "boolean" ? record.mergeChildren : null;
  const messaging = decodeMessaging(record.messaging);
  const workspaceMode = asString(record.workspaceMode);
  if (
    name === null ||
    digest === null ||
    placement === null ||
    allowedChildRoles === null ||
    mergeChildren === null ||
    messaging === null ||
    workspaceMode === null
  ) {
    return null;
  }
  return { name, digest, placement, allowedChildRoles, mergeChildren, messaging, workspaceMode };
}

const LIMIT_KEYS = ["maxDepth", "maxChildrenPerNode", "maxDescendants", "maxParallelNodes"] as const;

function decodeLimits(value: unknown): SnapshotManifestLimits | null {
  const record = asRecord(value);
  if (record === null) return null;
  const out: { -readonly [K in keyof SnapshotManifestLimits]: number } = {};
  for (const key of LIMIT_KEYS) {
    const entry = record[key];
    if (entry === undefined) continue;
    const limit = asInt(entry, 0);
    if (limit === null) return null;
    out[key] = limit;
  }
  return out;
}

function decodeManifest(value: unknown): SnapshotManifest | null {
  const record = asRecord(value);
  if (record === null) return null;
  const apiVersion = asString(record.apiVersion);
  const name = asString(record.name);
  const digest = asString(record.digest);
  const rootRecord = asRecord(record.root);
  const limits = decodeLimits(record.limits);
  if (apiVersion === null || name === null || digest === null || rootRecord === null || limits === null) {
    return null;
  }
  const rootName = asString(rootRecord.name);
  const rootRole = asString(rootRecord.role);
  if (rootName === null || rootRole === null) return null;
  if (!Array.isArray(record.roles)) return null;
  const roles: SnapshotRole[] = [];
  for (const entry of record.roles) {
    const role = decodeRole(entry);
    if (role === null) return null;
    roles.push(role);
  }
  return { apiVersion, name, digest, root: { name: rootName, role: rootRole }, limits, roles };
}

function decodeNode(value: unknown): SnapshotNode | null {
  const record = asRecord(value);
  if (record === null) return null;
  const nodeId = asString(record.nodeId);
  const parentNodeId = asNullableString(record.parentNodeId);
  const name = asString(record.name);
  const depth = asInt(record.depth, 0);
  const placement = asString(record.placement);
  const lifecycleStatus = asString(record.lifecycleStatus);
  const roleName = asString(record.roleName);
  const roleDigest = asString(record.roleDigest);
  const generation = asInt(record.generation, 0);
  if (
    nodeId === null ||
    parentNodeId === undefined ||
    name === null ||
    depth === null ||
    placement === null ||
    lifecycleStatus === null ||
    roleName === null ||
    roleDigest === null ||
    generation === null
  ) {
    return null;
  }
  return { nodeId, parentNodeId, name, depth, placement, lifecycleStatus, roleName, roleDigest, generation };
}

function decodeEdge(value: unknown): SnapshotEdge | null {
  const record = asRecord(value);
  if (record === null) return null;
  const fromNodeId = asString(record.fromNodeId);
  const toNodeId = asString(record.toNodeId);
  if (fromNodeId === null || toNodeId === null || record.kind !== "logical-parent") return null;
  return { fromNodeId, toNodeId, kind: "logical-parent" };
}

function decodeSummary(value: unknown): SnapshotSummary | null {
  const record = asRecord(value);
  if (record === null) return null;
  const nodeLifecycleCounts = asCountMap(record.nodeLifecycleCounts);
  const unresolvedOperationCounts = asCountMap(record.unresolvedOperationCounts);
  const stepStatusCounts = asCountMap(record.stepStatusCounts);
  const messageCounts = asCountMap(record.messageCounts);
  if (
    nodeLifecycleCounts === null ||
    unresolvedOperationCounts === null ||
    stepStatusCounts === null ||
    messageCounts === null
  ) {
    return null;
  }
  return { nodeLifecycleCounts, unresolvedOperationCounts, stepStatusCounts, messageCounts };
}

/**
 * Referential integrity of the decoded document. Fails closed: any
 * inconsistency means the snapshot is not displayed at all.
 */
function hasIntegrity(snapshot: ObservationSnapshot): boolean {
  const roleNames = new Set<string>();
  for (const role of snapshot.manifest.roles) {
    if (roleNames.has(role.name)) return false;
    roleNames.add(role.name);
  }
  if (!roleNames.has(snapshot.run.rootRole)) return false;
  if (!roleNames.has(snapshot.manifest.root.role)) return false;
  for (const role of snapshot.manifest.roles) {
    for (const child of role.allowedChildRoles) {
      if (!roleNames.has(child)) return false;
    }
  }

  const nodesById = new Map<string, SnapshotNode>();
  for (const node of snapshot.nodes) {
    if (nodesById.has(node.nodeId)) return false;
    if (!roleNames.has(node.roleName)) return false;
    nodesById.set(node.nodeId, node);
  }
  if (nodesById.size === 0) return false;

  const parentByChild = new Map<string, string>();
  const childIdsByParent = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (edge.fromNodeId === edge.toNodeId) return false;
    if (!nodesById.has(edge.fromNodeId) || !nodesById.has(edge.toNodeId)) return false;
    if (parentByChild.has(edge.toNodeId)) return false;
    parentByChild.set(edge.toNodeId, edge.fromNodeId);
    const siblings = childIdsByParent.get(edge.fromNodeId);
    if (siblings === undefined) childIdsByParent.set(edge.fromNodeId, [edge.toNodeId]);
    else siblings.push(edge.toNodeId);
  }

  let root: SnapshotNode | null = null;
  for (const node of snapshot.nodes) {
    const edgeParent = parentByChild.get(node.nodeId) ?? null;
    if (edgeParent !== node.parentNodeId) return false;
    if (node.parentNodeId === null) {
      if (root !== null) return false;
      root = node;
    }
  }
  if (root === null || root.depth !== 0) return false;

  let visited = 0;
  const stack: SnapshotNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    visited += 1;
    for (const childId of childIdsByParent.get(current.nodeId) ?? []) {
      const child = nodesById.get(childId);
      if (child === undefined || child.depth !== current.depth + 1) return false;
      stack.push(child);
    }
  }
  return visited === nodesById.size;
}

/**
 * Decode one snapshot command stdout document into a fresh allowlisted object.
 */
export function decodeObservationSnapshot(text: string): ObservationSnapshot | CockpitError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return cockpitError("invalid-json");
  }
  const document = asRecord(parsed);
  if (document === null) return cockpitError("invalid-snapshot");
  if (document.apiVersion !== OBSERVATION_API_VERSION || document.kind !== OBSERVATION_KIND) {
    return cockpitError("unsupported-version");
  }

  const observedAt = asString(document.observedAt);
  const run = decodeRun(document.run);
  const manifest = decodeManifest(document.manifest);
  const summary = decodeSummary(document.summary);
  if (observedAt === null || run === null || manifest === null || summary === null) {
    return cockpitError("invalid-snapshot");
  }
  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
    return cockpitError("invalid-snapshot");
  }
  const nodes: SnapshotNode[] = [];
  for (const entry of document.nodes) {
    const node = decodeNode(entry);
    if (node === null) return cockpitError("invalid-snapshot");
    nodes.push(node);
  }
  const edges: SnapshotEdge[] = [];
  for (const entry of document.edges) {
    const edge = decodeEdge(entry);
    if (edge === null) return cockpitError("invalid-snapshot");
    edges.push(edge);
  }

  const snapshot: ObservationSnapshot = {
    kind: "observation-snapshot",
    observedAt,
    run,
    manifest,
    nodes,
    edges,
    summary,
  };
  if (!hasIntegrity(snapshot)) return cockpitError("invalid-snapshot");
  return snapshot;
}
