import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const NODE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function createId(): string {
  return randomUUID();
}

export function nodeIdForRequest(treeId: string, requestKey: string): string {
  const digest = createHash("sha256").update(`${treeId}\0${requestKey}`).digest("hex");
  return `node-${digest.slice(0, 24)}`;
}

export function operationIdForRequest(treeId: string, kind: string, requestKey: string): string {
  const digest = createHash("sha256").update(`${treeId}\0${kind}\0${requestKey}`).digest("hex");
  return `op-${digest.slice(0, 24)}`;
}

export function normalizeNodeName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!NODE_NAME_PATTERN.test(normalized)) {
    throw new Error(`invalid node name: ${value}`);
  }
  return normalized;
}

export function branchForNode(parentBranch: string | null, nodeName: string): string {
  const name = normalizeNodeName(nodeName);
  return parentBranch === null ? `sheltie/${name}` : `${parentBranch}.${name}`;
}

export function worktreePathForBranch(worktreeRoot: string, branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("branch must produce a non-empty worktree slug");
  return join(worktreeRoot, slug);
}

export function agentNameForNode(nodeId: string): string {
  const suffix = nodeId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `s-${suffix || createHash("sha256").update(nodeId).digest("hex").slice(0, 12)}`.slice(0, 32);
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}
