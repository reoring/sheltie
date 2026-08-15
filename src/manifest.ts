import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NodePlacement, NodeSpawnPolicy } from "./db.ts";
import { requestHash } from "./ids.ts";
import { isRecord } from "./type-guards.ts";

export const MANIFEST_API_VERSION = "sheltie.dev/v1alpha1";
export const MANIFEST_KIND = "Run";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_TOTAL_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_ROLES = 128;
const MESSAGE_SCOPES = new Set(["parent", "children", "siblings"] as const);

export type MessageScope = "parent" | "children" | "siblings";
export type WorkspaceExecutionMode = "read-only" | "read-write";
export type ManifestParameterType = "string" | "integer" | "boolean";

export interface ManifestLimits {
  maxDepth: number;
  maxChildrenPerNode: number;
  maxDescendants: number;
  maxParallelNodes: number;
}

export interface ResolvedParameterDefinition {
  type: ManifestParameterType;
  required: boolean;
  maxLength?: number;
}

export interface ResolvedRoleCapabilities {
  spawn: {
    roles: string[];
    maxChildren?: number;
  };
  mergeChildren: boolean;
  messaging: {
    sendTo: MessageScope[];
    receiveFrom: MessageScope[];
  };
}

export interface ResolvedManifestRole {
  name: string;
  placement: NodePlacement;
  agent: {
    kind: string;
    args: string[];
  };
  prompt: {
    content: string;
    digest: string;
    source: string;
  };
  parameters: Record<string, ResolvedParameterDefinition>;
  capabilities: ResolvedRoleCapabilities;
  executionPolicy: {
    workspace: WorkspaceExecutionMode;
  };
  digest: string;
}

export interface ResolvedRunManifest {
  apiVersion: typeof MANIFEST_API_VERSION;
  kind: typeof MANIFEST_KIND;
  metadata: {
    name: string;
  };
  spec: {
    root: {
      role: string;
      name: string;
    };
    limits: ManifestLimits;
    roles: Record<string, ResolvedManifestRole>;
  };
}

export interface ResolvedManifestDocument {
  digest: string;
  canonicalJson: string;
  manifest: ResolvedRunManifest;
  sourcePath: string;
}

export interface ManifestValidationIssue {
  path: string;
  message: string;
}

export class ManifestValidationError extends Error {
  readonly issues: readonly ManifestValidationIssue[];

  constructor(issues: readonly ManifestValidationIssue[]) {
    const normalized = issues.map(({ path, message }) => ({ path, message }));
    super(["manifest validation failed", ...normalized.map((issue) => `${issue.path}: ${issue.message}`)].join("\n"));
    this.name = "ManifestValidationError";
    this.issues = normalized;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

class PathValidationError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "PathValidationError";
  }
}

function fail(path: string, detail: string): never {
  throw new PathValidationError(path, detail);
}


function issueFrom(error: unknown, fallbackPath: string): ManifestValidationIssue {
  if (error instanceof PathValidationError) return { path: error.path, message: error.detail };
  const message = error instanceof Error ? error.message : String(error);
  const separator = message.indexOf(": ");
  return separator === -1
    ? { path: fallbackPath, message }
    : { path: message.slice(0, separator), message: message.slice(separator + 2) };
}

class IssueCollector {
  readonly #issues: ManifestValidationIssue[] = [];

  add(path: string, message: string): void {
    this.#issues.push({ path, message });
  }

  capture<T>(fallbackPath: string, parse: () => T): T | undefined {
    try {
      return parse();
    } catch (error) {
      const issue = issueFrom(error, fallbackPath);
      this.add(issue.path, issue.message);
      return undefined;
    }
  }

  sorted(): ManifestValidationIssue[] {
    return this.#issues.toSorted((left, right) => {
      if (left.path < right.path) return -1;
      if (left.path > right.path) return 1;
      if (left.message < right.message) return -1;
      if (left.message > right.message) return 1;
      return 0;
    });
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path}: expected a non-empty string`);
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected a boolean`);
  return value;
}

function integerAt(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${path}: expected an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function assertName(value: string, path: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(`${path}: must match ${NAME_PATTERN.source}`);
  }
  return value;
}

function collectKnownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: IssueCollector,
): boolean {
  const allowedSet = new Set(allowed);
  let valid = true;
  for (const key of Object.keys(record).sort()) {
    if (!allowedSet.has(key)) {
      issues.add(`${path}.${key}`, "unknown field");
      valid = false;
    }
  }
  return valid;
}

function collectStringArray(value: unknown, path: string, issues: IssueCollector): string[] | undefined {
  const entries = issues.capture(path, () => {
    if (!Array.isArray(value)) fail(path, "expected an array");
    return value;
  });
  if (entries === undefined) return undefined;

  const strings: string[] = [];
  let valid = true;
  for (const [index, entry] of entries.entries()) {
    const string = issues.capture(`${path}[${index}]`, () => stringAt(entry, `${path}[${index}]`));
    if (string === undefined) {
      valid = false;
      continue;
    }
    strings.push(string);
  }
  return valid ? strings : undefined;
}

function collectMessageScopes(value: unknown, path: string, issues: IssueCollector): MessageScope[] | undefined {
  const entries = collectStringArray(value, path, issues);
  if (entries === undefined) return undefined;

  const scopes: MessageScope[] = [];
  const seen = new Set<string>();
  let valid = true;
  for (const [index, entry] of entries.entries()) {
    if (!MESSAGE_SCOPES.has(entry as MessageScope)) {
      issues.add(`${path}[${index}]`, "expected parent, children, or siblings");
      valid = false;
      continue;
    }
    if (seen.has(entry)) {
      issues.add(`${path}[${index}]`, `duplicate scope ${entry}`);
      valid = false;
      continue;
    }
    seen.add(entry);
    scopes.push(entry as MessageScope);
  }
  return valid ? scopes : undefined;
}

function yamlSyntaxOutsideQuotedStrings(line: string): string {
  let result = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (quote !== null) {
      result += " ";
      if (quote === "\"" && character === "\\") {
        index += 1;
        result += " ";
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "#") break;
    if (character === "\"" || character === "'") {
      quote = character;
      result += " ";
      continue;
    }
    result += character;
  }
  return result;
}

function assertSupportedYaml(source: string): void {
  if (Buffer.byteLength(source) > MAX_MANIFEST_BYTES) {
    fail("manifest", `exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  if (source.includes("\t")) fail("manifest", "YAML tabs are not supported");
  if (/^\s*(?:---|\.\.\.)\s*$/m.test(source)) fail("manifest", "YAML document markers are not supported");

  const scopes: Array<{ indent: number; path: string; keys: Set<string> }> = [
    { indent: -1, path: "", keys: new Set() },
  ];
  let blockScalarIndent: number | null = null;
  for (const [lineIndex, line] of source.split("\n").entries()) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    const trimmed = line.trimStart();
    if (/^(?:\?\s|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*:)/.test(trimmed)) {
      fail(`manifest:${lineIndex + 1}`, "quoted and explicit YAML mapping keys are not supported");
    }
    const syntax = yamlSyntaxOutsideQuotedStrings(trimmed);
    if (/(?:^|[\s:[,\-])(?:[&*][^\s,\[\]{}]+|![^\s,\[\]{}]*)/.test(syntax)) {
      fail(`manifest:${lineIndex + 1}`, "YAML anchors, aliases, and tags are not supported");
    }
    const match = /^(\s*)([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?$/.exec(line);
    if (match === null) continue;
    const key = match[2] as string;
    const rawValue = (match[3] ?? "").trim();
    if (rawValue.startsWith("{")) {
      fail(`manifest:${lineIndex + 1}`, "flow mappings are not supported");
    }
    while ((scopes.at(-1)?.indent ?? -1) >= indent) scopes.pop();
    const parent = scopes.at(-1);
    if (parent === undefined) fail(`manifest:${lineIndex + 1}`, "invalid YAML indentation");
    const keyPath = parent.path.length === 0 ? key : `${parent.path}.${key}`;
    if (parent.keys.has(key)) fail(keyPath, "duplicate YAML mapping key");
    parent.keys.add(key);
    if (rawValue === "") scopes.push({ indent, path: keyPath, keys: new Set() });
    else if (/^[|>](?:[+-]?\d?|\d?[+-]?)(?:\s+#.*)?$/.test(rawValue)) {
      blockScalarIndent = indent;
    }
  }
}

function collectPrompt(
  promptValue: unknown,
  path: string,
  manifestDirectory: string,
  issues: IssueCollector,
): { content: string; digest: string; source: string } | undefined {
  const prompt = issues.capture(path, () => objectAt(promptValue, path));
  if (prompt === undefined) return undefined;

  let valid = collectKnownFields(prompt, ["file", "inline"], path, issues);
  const hasFile = prompt.file !== undefined;
  const hasInline = prompt.inline !== undefined;
  if (hasFile === hasInline) {
    issues.add(path, "exactly one of file or inline is required");
    return undefined;
  }

  let content: string | undefined;
  let source: string | undefined;
  if (hasInline) {
    content = issues.capture(`${path}.inline`, () => stringAt(prompt.inline, `${path}.inline`));
    source = "inline";
  } else {
    const file = issues.capture(`${path}.file`, () => stringAt(prompt.file, `${path}.file`));
    if (file === undefined) return undefined;
    if (isAbsolute(file)) {
      issues.add(`${path}.file`, "path must be relative to the manifest directory");
      return undefined;
    }
    const candidate = resolve(manifestDirectory, file);
    let stat: Stats;
    try {
      stat = lstatSync(candidate);
    } catch {
      issues.add(`${path}.file`, `prompt file does not exist: ${file}`);
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      issues.add(`${path}.file`, "symlinks are not allowed");
      return undefined;
    }
    if (!stat.isFile()) {
      issues.add(`${path}.file`, "expected a regular file");
      return undefined;
    }
    let exact: string;
    let manifestRoot: string;
    try {
      manifestRoot = realpathSync(manifestDirectory);
      exact = realpathSync(candidate);
    } catch (error) {
      issues.add(
        `${path}.file`,
        `could not resolve prompt file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    const relativePath = relative(manifestRoot, exact);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      issues.add(`${path}.file`, "path must remain inside the manifest directory");
      return undefined;
    }
    if (stat.size > MAX_PROMPT_BYTES) {
      issues.add(`${path}.file`, `prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
      return undefined;
    }
    try {
      content = readFileSync(exact, "utf8");
    } catch (error) {
      issues.add(
        `${path}.file`,
        `could not read prompt file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    source = file;
  }

  if (content === undefined || source === undefined) return undefined;
  if (content.trim().length === 0) {
    issues.add(path, "prompt must not be empty");
    valid = false;
  }
  if (Buffer.byteLength(content) > MAX_PROMPT_BYTES) {
    issues.add(path, `prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
    valid = false;
  }
  return valid ? { content, digest: requestHash(content), source } : undefined;
}

function collectParameters(
  value: unknown,
  path: string,
  issues: IssueCollector,
): Record<string, ResolvedParameterDefinition> | undefined {
  if (value === undefined) return {};
  const parameters = issues.capture(path, () => objectAt(value, path));
  if (parameters === undefined) return undefined;

  const resolved: Record<string, ResolvedParameterDefinition> = {};
  let valid = true;
  for (const name of Object.keys(parameters).sort()) {
    const namePath = `${path}.${name}`;
    const validName = issues.capture(namePath, () => assertName(name, namePath));
    const definition = issues.capture(namePath, () => objectAt(parameters[name], namePath));
    if (definition === undefined || validName === undefined) {
      valid = false;
      continue;
    }

    if (!collectKnownFields(definition, ["type", "required", "maxLength"], namePath, issues)) valid = false;
    const type = issues.capture(`${namePath}.type`, () => {
      const raw = stringAt(definition.type, `${namePath}.type`);
      if (raw !== "string" && raw !== "integer" && raw !== "boolean") {
        fail(`${namePath}.type`, "expected string, integer, or boolean");
      }
      return raw as ManifestParameterType;
    });
    const required = definition.required === undefined
      ? false
      : issues.capture(`${namePath}.required`, () => booleanAt(definition.required, `${namePath}.required`));
    const hasMaxLength = definition.maxLength !== undefined;
    const maxLength = hasMaxLength
      ? issues.capture(`${namePath}.maxLength`, () => integerAt(definition.maxLength, `${namePath}.maxLength`, 1, 16_384))
      : undefined;
    if (type !== undefined && type !== "string" && maxLength !== undefined) {
      issues.add(`${namePath}.maxLength`, "only valid for string parameters");
      valid = false;
    }
    if (type === undefined || required === undefined || (hasMaxLength && maxLength === undefined)) {
      valid = false;
      continue;
    }
    resolved[name] = { type, required, ...(maxLength === undefined ? {} : { maxLength }) };
  }
  return valid ? resolved : undefined;
}

interface CapabilityValidation {
  value?: ResolvedRoleCapabilities;
  spawnRoles?: string[];
}

function collectCapabilities(value: unknown, path: string, issues: IssueCollector): CapabilityValidation {
  const capabilities = issues.capture(path, () => objectAt(value, path));
  if (capabilities === undefined) return {};

  let valid = collectKnownFields(capabilities, ["spawn", "mergeChildren", "messaging"], path, issues);
  const spawn = issues.capture(`${path}.spawn`, () => objectAt(capabilities.spawn, `${path}.spawn`));
  let spawnRoles: string[] | undefined;
  let maxChildren: number | undefined;
  if (spawn === undefined) {
    valid = false;
  } else {
    if (!collectKnownFields(spawn, ["roles", "maxChildren"], `${path}.spawn`, issues)) valid = false;
    const roles = collectStringArray(spawn.roles, `${path}.spawn.roles`, issues);
    if (roles === undefined) {
      valid = false;
    } else {
      let validRoleNames = true;
      for (const [index, role] of roles.entries()) {
        if (issues.capture(`${path}.spawn.roles[${index}]`, () => assertName(role, `${path}.spawn.roles[${index}]`)) === undefined) {
          validRoleNames = false;
        }
      }
      if (new Set(roles).size !== roles.length) {
        issues.add(`${path}.spawn.roles`, "duplicate role");
        validRoleNames = false;
      }
      if (validRoleNames) spawnRoles = roles;
      else valid = false;
    }
    const hasMaxChildren = spawn.maxChildren !== undefined;
    maxChildren = hasMaxChildren
      ? issues.capture(`${path}.spawn.maxChildren`, () =>
        integerAt(spawn.maxChildren, `${path}.spawn.maxChildren`, 1, 64))
      : undefined;
    if (hasMaxChildren && maxChildren === undefined) valid = false;
  }

  const mergeChildren = issues.capture(`${path}.mergeChildren`, () =>
    booleanAt(capabilities.mergeChildren, `${path}.mergeChildren`));
  if (mergeChildren === undefined) valid = false;

  const messaging = issues.capture(`${path}.messaging`, () => objectAt(capabilities.messaging, `${path}.messaging`));
  let sendTo: MessageScope[] | undefined;
  let receiveFrom: MessageScope[] | undefined;
  if (messaging === undefined) {
    valid = false;
  } else {
    if (!collectKnownFields(messaging, ["sendTo", "receiveFrom"], `${path}.messaging`, issues)) valid = false;
    sendTo = collectMessageScopes(messaging.sendTo, `${path}.messaging.sendTo`, issues);
    receiveFrom = collectMessageScopes(messaging.receiveFrom, `${path}.messaging.receiveFrom`, issues);
    if (sendTo === undefined || receiveFrom === undefined) valid = false;
  }

  if (
    !valid ||
    spawnRoles === undefined ||
    mergeChildren === undefined ||
    sendTo === undefined ||
    receiveFrom === undefined
  ) {
    return { ...(spawnRoles === undefined ? {} : { spawnRoles }) };
  }
  return {
    value: {
      spawn: { roles: spawnRoles, ...(maxChildren === undefined ? {} : { maxChildren }) },
      mergeChildren,
      messaging: { sendTo, receiveFrom },
    },
    spawnRoles,
  };
}

function collectAgent(
  value: unknown,
  path: string,
  issues: IssueCollector,
): ResolvedManifestRole["agent"] | undefined {
  const agent = issues.capture(path, () => objectAt(value, path));
  if (agent === undefined) return undefined;

  let valid = collectKnownFields(agent, ["kind", "args"], path, issues);
  const kind = issues.capture(`${path}.kind`, () => assertName(stringAt(agent.kind, `${path}.kind`), `${path}.kind`));
  const args = agent.args === undefined ? [] : collectStringArray(agent.args, `${path}.args`, issues);
  if (args === undefined) {
    valid = false;
  } else {
    if (args.length > 32) {
      issues.add(`${path}.args`, "at most 32 arguments are allowed");
      valid = false;
    }
    for (const [index, argument] of args.entries()) {
      if (argument.length > 4096) {
        issues.add(`${path}.args[${index}]`, "exceeds 4096 characters");
        valid = false;
      }
    }
  }
  return valid && kind !== undefined && args !== undefined ? { kind, args } : undefined;
}

interface RoleValidation {
  value?: ResolvedManifestRole;
  placement?: NodePlacement;
  spawnRoles?: string[];
}

function collectRole(
  name: string,
  value: unknown,
  path: string,
  manifestDirectory: string,
  issues: IssueCollector,
): RoleValidation {
  const role = issues.capture(path, () => objectAt(value, path));
  if (role === undefined) return {};

  let valid = collectKnownFields(
    role,
    ["placement", "agent", "prompt", "parameters", "capabilities", "executionPolicy"],
    path,
    issues,
  );
  const placement = issues.capture(`${path}.placement`, () => {
    const placementValue = stringAt(role.placement, `${path}.placement`);
    if (placementValue !== "workspace" && placementValue !== "tab") {
      fail(`${path}.placement`, "expected workspace or tab");
    }
    return placementValue as NodePlacement;
  });
  if (placement === undefined) valid = false;

  const prompt = collectPrompt(role.prompt, `${path}.prompt`, manifestDirectory, issues);
  if (prompt === undefined) valid = false;
  const parameters = collectParameters(role.parameters, `${path}.parameters`, issues);
  if (parameters === undefined) valid = false;
  const capabilities = collectCapabilities(role.capabilities, `${path}.capabilities`, issues);
  if (capabilities.value === undefined) valid = false;
  const agent = collectAgent(role.agent, `${path}.agent`, issues);
  if (agent === undefined) valid = false;

  let workspace: WorkspaceExecutionMode | undefined;
  if (role.executionPolicy === undefined) {
    if (placement !== undefined) workspace = placement === "tab" ? "read-only" : "read-write";
  } else {
    const policy = issues.capture(`${path}.executionPolicy`, () =>
      objectAt(role.executionPolicy, `${path}.executionPolicy`));
    if (policy === undefined) {
      valid = false;
    } else {
      if (!collectKnownFields(policy, ["workspace"], `${path}.executionPolicy`, issues)) valid = false;
      workspace = issues.capture(`${path}.executionPolicy.workspace`, () => {
        const workspaceValue = stringAt(policy.workspace, `${path}.executionPolicy.workspace`);
        if (workspaceValue !== "read-only" && workspaceValue !== "read-write") {
          fail(`${path}.executionPolicy.workspace`, "expected read-only or read-write");
        }
        return workspaceValue as WorkspaceExecutionMode;
      });
      if (workspace === undefined) valid = false;
    }
  }

  if (
    !valid ||
    placement === undefined ||
    prompt === undefined ||
    parameters === undefined ||
    capabilities.value === undefined ||
    agent === undefined ||
    workspace === undefined
  ) {
    return {
      ...(placement === undefined ? {} : { placement }),
      ...(capabilities.spawnRoles === undefined ? {} : { spawnRoles: capabilities.spawnRoles }),
    };
  }
  const content: Omit<ResolvedManifestRole, "digest"> = {
    name,
    placement,
    agent,
    prompt,
    parameters,
    capabilities: capabilities.value,
    executionPolicy: { workspace },
  };
  return {
    value: { ...content, digest: requestHash(content) },
    placement,
    ...(capabilities.spawnRoles === undefined ? {} : { spawnRoles: capabilities.spawnRoles }),
  };
}
function collectSpawnMessagingSymmetry(
  roleNames: readonly string[],
  roles: ReadonlyMap<string, RoleValidation>,
  issues: IssueCollector,
): void {
  for (const parentRoleName of roleNames) {
    const parent = roles.get(parentRoleName)?.value;
    if (parent === undefined) continue;

    for (const childRoleName of parent.capabilities.spawn.roles) {
      const child = roles.get(childRoleName)?.value;
      if (child === undefined) continue;

      if (
        parent.capabilities.messaging.sendTo.includes("children") &&
        !child.capabilities.messaging.receiveFrom.includes("parent")
      ) {
        issues.add(
          `spec.roles.${childRoleName}.capabilities.messaging.receiveFrom`,
          `must include parent because parent role "${parentRoleName}" sends to children`,
        );
      }
      if (
        child.capabilities.messaging.sendTo.includes("parent") &&
        !parent.capabilities.messaging.receiveFrom.includes("children")
      ) {
        issues.add(
          `spec.roles.${parentRoleName}.capabilities.messaging.receiveFrom`,
          `must include children because child role "${childRoleName}" sends to parent`,
        );
      }
    }
  }
}

function collectLimits(value: unknown, path: string, issues: IssueCollector): ManifestLimits | undefined {
  const limits = issues.capture(path, () => objectAt(value, path));
  if (limits === undefined) return undefined;

  let valid = collectKnownFields(
    limits,
    ["maxDepth", "maxChildrenPerNode", "maxDescendants", "maxParallelNodes"],
    path,
    issues,
  );
  const maxDepth = issues.capture(`${path}.maxDepth`, () => integerAt(limits.maxDepth, `${path}.maxDepth`, 1, 32));
  const maxChildrenPerNode = issues.capture(`${path}.maxChildrenPerNode`, () =>
    integerAt(limits.maxChildrenPerNode, `${path}.maxChildrenPerNode`, 1, 64));
  const maxDescendants = issues.capture(`${path}.maxDescendants`, () =>
    integerAt(limits.maxDescendants, `${path}.maxDescendants`, 1, 1024));
  const maxParallelNodes = issues.capture(`${path}.maxParallelNodes`, () =>
    integerAt(limits.maxParallelNodes, `${path}.maxParallelNodes`, 1, 64));
  if (
    maxDepth === undefined ||
    maxChildrenPerNode === undefined ||
    maxDescendants === undefined ||
    maxParallelNodes === undefined
  ) {
    valid = false;
  }
  return valid &&
      maxDepth !== undefined &&
      maxChildrenPerNode !== undefined &&
      maxDescendants !== undefined &&
      maxParallelNodes !== undefined
    ? { maxDepth, maxChildrenPerNode, maxDescendants, maxParallelNodes }
    : undefined;
}

export function resolveManifestFile(path: string): ResolvedManifestDocument {
  let sourcePath = "";
  let source = "";
  try {
    sourcePath = realpathSync(path);
    source = readFileSync(sourcePath, "utf8");
    assertSupportedYaml(source);
  } catch (error) {
    if (error instanceof PathValidationError) {
      throw new ManifestValidationError([{ path: error.path, message: error.detail }]);
    }
    throw new ManifestValidationError([{
      path: "manifest",
      message: error instanceof Error ? error.message : String(error),
    }]);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error) {
    throw new ManifestValidationError([{
      path: "manifest",
      message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }

  const documentIssues = new IssueCollector();
  const roleIssues = new IssueCollector();
  const crossReferenceIssues = new IssueCollector();
  const root = documentIssues.capture("manifest", () => objectAt(parsed, "manifest"));
  let metadataName: string | undefined;
  let rootRole: string | undefined;
  let rootName: string | undefined;
  let limits: ManifestLimits | undefined;
  let rolesValue: Record<string, unknown> | undefined;
  let roleNames: string[] = [];
  const roles = new Map<string, RoleValidation>();
  const validRoleNames = new Set<string>();

  if (root !== undefined) {
    collectKnownFields(root, ["apiVersion", "kind", "metadata", "spec"], "manifest", documentIssues);
    if (root.apiVersion !== MANIFEST_API_VERSION) {
      documentIssues.add("apiVersion", `expected ${MANIFEST_API_VERSION}`);
    }
    if (root.kind !== MANIFEST_KIND) documentIssues.add("kind", `expected ${MANIFEST_KIND}`);

    const metadata = documentIssues.capture("metadata", () => objectAt(root.metadata, "metadata"));
    if (metadata !== undefined) {
      collectKnownFields(metadata, ["name"], "metadata", documentIssues);
      metadataName = documentIssues.capture("metadata.name", () => assertName(stringAt(metadata.name, "metadata.name"), "metadata.name"));
    }

    const spec = documentIssues.capture("spec", () => objectAt(root.spec, "spec"));
    if (spec !== undefined) {
      collectKnownFields(spec, ["root", "limits", "roles"], "spec", documentIssues);
      const rootSpec = documentIssues.capture("spec.root", () => objectAt(spec.root, "spec.root"));
      if (rootSpec !== undefined) {
        collectKnownFields(rootSpec, ["role", "name"], "spec.root", documentIssues);
        rootRole = documentIssues.capture("spec.root.role", () =>
          assertName(stringAt(rootSpec.role, "spec.root.role"), "spec.root.role"));
        rootName = documentIssues.capture("spec.root.name", () =>
          assertName(stringAt(rootSpec.name, "spec.root.name"), "spec.root.name"));
      }
      limits = collectLimits(spec.limits, "spec.limits", documentIssues);
      rolesValue = documentIssues.capture("spec.roles", () => objectAt(spec.roles, "spec.roles"));
      if (rolesValue !== undefined) {
        roleNames = Object.keys(rolesValue).sort();
        if (roleNames.length === 0 || roleNames.length > MAX_ROLES) {
          documentIssues.add("spec.roles", `expected 1-${MAX_ROLES} roles`);
        } else {
          for (const roleName of roleNames) {
            const rolePath = `spec.roles.${roleName}`;
            if (roleIssues.capture(rolePath, () => assertName(roleName, rolePath)) !== undefined) {
              validRoleNames.add(roleName);
            }
            roles.set(
              roleName,
              collectRole(roleName, rolesValue[roleName], rolePath, dirname(sourcePath), roleIssues),
            );
          }
        }
      }
    }
  }

  let promptBytes = 0;
  for (const role of roles.values()) {
    if (role.value !== undefined) promptBytes += Buffer.byteLength(role.value.prompt.content);
  }
  if (promptBytes > MAX_TOTAL_PROMPT_BYTES) {
    documentIssues.add("spec.roles", `resolved prompts exceed ${MAX_TOTAL_PROMPT_BYTES} bytes`);
  }

  if (rolesValue !== undefined) {
    if (rootRole !== undefined && !Object.hasOwn(rolesValue, rootRole)) {
      crossReferenceIssues.add("spec.root.role", `role "${rootRole}" does not exist`);
    } else if (rootRole !== undefined && roles.get(rootRole)?.placement === "tab") {
      crossReferenceIssues.add("spec.root.role", "root role must use workspace placement");
    }
    for (const roleName of roleNames) {
      const spawnRoles = roles.get(roleName)?.spawnRoles;
      if (spawnRoles === undefined) continue;
      for (const [index, childRole] of spawnRoles.entries()) {
        if (!Object.hasOwn(rolesValue, childRole)) {
          crossReferenceIssues.add(
            `spec.roles.${roleName}.capabilities.spawn.roles[${index}]`,
            `role "${childRole}" does not exist`,
          );
        }
      }
    }
    collectSpawnMessagingSymmetry(
      roleNames.filter((roleName) => validRoleNames.has(roleName)),
      roles,
      crossReferenceIssues,
    );
  }

  const issues = [
    ...documentIssues.sorted(),
    ...roleIssues.sorted(),
    ...crossReferenceIssues.sorted(),
  ];
  if (issues.length > 0) throw new ManifestValidationError(issues);

  if (
    metadataName === undefined ||
    rootRole === undefined ||
    rootName === undefined ||
    limits === undefined ||
    rolesValue === undefined
  ) {
    throw new Error("manifest resolution did not produce a complete manifest");
  }

  const resolvedRoles: Record<string, ResolvedManifestRole> = {};
  for (const roleName of roleNames) {
    const role = roles.get(roleName)?.value;
    if (role === undefined) throw new Error(`manifest resolution did not produce role ${roleName}`);
    resolvedRoles[roleName] = role;
  }
  const manifest: ResolvedRunManifest = {
    apiVersion: MANIFEST_API_VERSION,
    kind: MANIFEST_KIND,
    metadata: { name: metadataName },
    spec: { root: { role: rootRole, name: rootName }, limits, roles: resolvedRoles },
  };
  const json = canonicalJson(manifest);
  return { digest: requestHash(manifest), canonicalJson: json, manifest, sourcePath };
}

export function parseResolvedManifest(value: unknown): ResolvedRunManifest {
  const manifest = objectAt(value, "resolved manifest");
  if (manifest.apiVersion !== MANIFEST_API_VERSION || manifest.kind !== MANIFEST_KIND) {
    throw new Error("resolved manifest has an unsupported identity");
  }
  const spec = objectAt(manifest.spec, "resolved manifest.spec");
  const roles = objectAt(spec.roles, "resolved manifest.spec.roles");
  const root = objectAt(spec.root, "resolved manifest.spec.root");
  const rootRole = stringAt(root.role, "resolved manifest.spec.root.role");
  if (roles[rootRole] === undefined) throw new Error(`resolved manifest root role ${rootRole} is missing`);
  return value as unknown as ResolvedRunManifest;
}

export function getManifestRole(manifest: ResolvedRunManifest, roleName: string): ResolvedManifestRole {
  const role = manifest.spec.roles[roleName];
  if (role === undefined) throw new Error(`manifest role ${roleName} does not exist`);
  return role;
}

export function resolveRoleParameters(
  role: ResolvedManifestRole,
  value: unknown,
): Record<string, string | number | boolean> {
  const input = value === undefined ? {} : objectAt(value, `role ${role.name} parameters`);
  const result: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(input)) {
    if (role.parameters[key] === undefined) throw new Error(`role ${role.name} parameters.${key}: unknown parameter`);
  }
  for (const name of Object.keys(role.parameters).sort()) {
    const definition = role.parameters[name] as ResolvedParameterDefinition;
    const parameter = input[name];
    if (parameter === undefined) {
      if (definition.required) throw new Error(`role ${role.name} parameters.${name}: required parameter is missing`);
      continue;
    }
    if (definition.type === "string") {
      if (typeof parameter !== "string") throw new Error(`role ${role.name} parameters.${name}: expected a string`);
      if (definition.maxLength !== undefined && parameter.length > definition.maxLength) {
        throw new Error(`role ${role.name} parameters.${name}: exceeds ${definition.maxLength} characters`);
      }
      result[name] = parameter;
    } else if (definition.type === "integer") {
      if (!Number.isInteger(parameter)) throw new Error(`role ${role.name} parameters.${name}: expected an integer`);
      result[name] = parameter as number;
    } else {
      if (typeof parameter !== "boolean") throw new Error(`role ${role.name} parameters.${name}: expected a boolean`);
      result[name] = parameter;
    }
  }
  return result;
}

export function spawnPolicyForRole(manifest: ResolvedRunManifest, role: ResolvedManifestRole): NodeSpawnPolicy {
  const placements = new Set(role.capabilities.spawn.roles.map((name) => getManifestRole(manifest, name).placement));
  if (placements.size === 0) return "none";
  if (placements.size === 2) return "both";
  return placements.has("workspace") ? "workspace" : "tab";
}

export function relationFromNode(
  source: { nodeId: string; parentNodeId: string | null },
  target: { nodeId: string; parentNodeId: string | null },
): MessageScope | null {
  if (source.parentNodeId === target.nodeId) return "parent";
  if (target.parentNodeId === source.nodeId) return "children";
  if (source.parentNodeId !== null && source.parentNodeId === target.parentNodeId) return "siblings";
  return null;
}
