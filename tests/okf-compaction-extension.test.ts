import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import okfCompactionExtension from "../extensions/okf-compaction.ts";

const roots: string[] = [];
const RELEVANT_EVENTS = [
  "auto_compaction_start",
  "session.compacting",
  "session_compact",
  "auto_compaction_end",
] as const;
const REQUIRED_FLAGS = ["sheltie-okf-dir", "sheltie-okf-role"] as const;
type RelevantEvent = (typeof RELEVANT_EVENTS)[number];
type EventHandler = (event: unknown, context: unknown) => unknown;

interface RegisteredFlag {
  type: "string" | "boolean";
  description?: string;
  default?: string | boolean;
}

interface Fixture {
  root: string;
  outputDir: string;
}

class FakeExtensionApi {
  readonly handlers = new Map<RelevantEvent, EventHandler>();
  readonly flags = new Map<string, RegisteredFlag>();

  constructor(private readonly values: Record<string, string> = {}) {}

  on(event: RelevantEvent, handler: EventHandler): void {
    if (this.handlers.has(event)) throw new Error(`duplicate handler registration for ${event}`);
    this.handlers.set(event, handler);
  }

  registerFlag(name: string, options: RegisteredFlag): void {
    if (this.flags.has(name)) throw new Error(`duplicate flag registration for ${name}`);
    this.flags.set(name, options);
  }

  getFlag(name: string): string | undefined {
    return this.values[name];
  }

  setFlag(name: string, value: string): void {
    this.values[name] = value;
  }

  async emit(event: RelevantEvent, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (handler === undefined) throw new Error(`missing ${event} handler`);
    return await handler(payload, {});
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sheltie-okf-compaction-extension-"));
  roots.push(root);
  return { root, outputDir: join(root, "knowledge", "node-0123456789abcdef") };
}

async function loadExtension(outputDir: string): Promise<FakeExtensionApi> {
  const api = new FakeExtensionApi();
  await okfCompactionExtension(api as never);
  api.setFlag("sheltie-okf-dir", outputDir);
  api.setFlag("sheltie-okf-role", "coordinator");
  return api;
}

function automaticStart() {
  return {
    type: "auto_compaction_start",
    reason: "threshold",
    action: "context-full",
  };
}

function automaticEnd() {
  return {
    type: "auto_compaction_end",
    action: "context-full",
    result: undefined,
    aborted: false,
    willRetry: false,
  };
}

function compactingEvent() {
  return { type: "session.compacting", sessionId: "session-test", messages: [] };
}

function compactedEvent(summary: string) {
  return {
    type: "session_compact",
    fromExtension: false,
    compactionEntry: {
      type: "compaction",
      id: "compaction-test",
      parentId: "entry-before-compaction",
      timestamp: "2026-08-15T00:00:00.000Z",
      firstKeptEntryId: "entry-after-compaction",
      tokensBefore: 8192,
      summary,
    },
  };
}

function summaryWithMarker(content: string): string {
  return [
    "RAW_TRANSCRIPT_DO_NOT_PERSIST: user prompt and tool result api_key=outside-marker",
    "<sheltie-okf>",
    content,
    "</sheltie-okf>",
    "RAW_TRANSCRIPT_SUFFIX_DO_NOT_PERSIST: terminal_id=outside-marker",
  ].join("\n");
}

function markerInstruction(result: unknown): string {
  if (result === null || typeof result !== "object" || !(("context" in result))) {
    throw new Error("session.compacting must return marker context while automatic compaction is active");
  }
  const { context } = result;
  if (!Array.isArray(context) || !context.every((line) => typeof line === "string")) {
    throw new Error("session.compacting marker context must be an array of strings");
  }
  return context.join("\n");
}

function conceptNames(outputDir: string): string[] {
  const conceptsDir = join(outputDir, "concepts");
  if (!existsSync(conceptsDir)) return [];
  return readdirSync(conceptsDir)
    .filter((name) => name.startsWith("compaction-") && name.endsWith(".md"))
    .sort();
}

function frontmatter(markdown: string): string {
  const match = markdown.match(/^---\n([\s\S]+?)\n---\n/);
  if (match === null) throw new Error("expected YAML frontmatter");
  return match[1]!;
}

function sourceResources(metadata: string): string[] {
  return metadata
    .split("\n")
    .map((line) => line.match(/^\s*(?:-\s+)?resource:\s*(.+?)\s*$/)?.[1])
    .filter((resource): resource is string => resource !== undefined)
    .map((resource) => resource.replace(/^['"]|['"]$/g, ""));
}

describe("OKF automatic-compaction extension", () => {
  test("registers only scoped flags and requests a bounded marker for automatic context-full compaction", async () => {
    const fixture = createFixture();
    const api = await loadExtension(fixture.outputDir);

    expect([...api.handlers.keys()].sort()).toEqual([...RELEVANT_EVENTS].sort());
    expect([...api.flags.keys()].sort()).toEqual([...REQUIRED_FLAGS].sort());
    for (const flag of REQUIRED_FLAGS) expect(api.flags.get(flag)?.type).toBe("string");

    expect(await api.emit("session.compacting", compactingEvent())).toBeUndefined();

    await api.emit("auto_compaction_start", automaticStart());
    const instruction = markerInstruction(await api.emit("session.compacting", compactingEvent()));
    expect(instruction).toContain("<sheltie-okf>");
    expect(instruction).toContain("</sheltie-okf>");
    expect(instruction).toMatch(/\b(must|required|only)\b/i);
    expect(instruction.length).toBeLessThanOrEqual(1024);

    await api.emit("auto_compaction_end", automaticEnd());
    expect(await api.emit("session.compacting", compactingEvent())).toBeUndefined();
  });

  test("writes one idempotent portable draft OKF v0.2 concept from valid automatic marker content only", async () => {
    const fixture = createFixture();
    const api = await loadExtension(fixture.outputDir);
    const markerContent = [
      "# Compaction boundary",
      "",
      "Compaction boundary recorded.",
      "",
      "- Preserve the agreed ownership boundary for the next session.",
    ].join("\n");
    const summary = summaryWithMarker(markerContent);

    await api.emit("auto_compaction_start", automaticStart());
    markerInstruction(await api.emit("session.compacting", compactingEvent()));
    await api.emit("session_compact", compactedEvent(summary));

    const names = conceptNames(fixture.outputDir);
    expect(names).toHaveLength(1);
    const conceptName = names[0]!;
    expect(conceptName).toMatch(/^compaction-[a-f0-9]{64}\.md$/);

    const index = readFileSync(join(fixture.outputDir, "index.md"), "utf8");
    expect(index).toMatch(/^---\nokf_version:\s*["']?0\.2["']?\n---/);
    expect(index).toContain("Private, derived OKF concepts written during automatic context compaction.");
    expect(index).toContain("[Content-addressed concepts](./concepts/)");
    expect(index).not.toContain(conceptName);

    const conceptPath = join(fixture.outputDir, "concepts", conceptName);
    const concept = readFileSync(conceptPath, "utf8");
    const metadata = frontmatter(concept);
    expect(metadata).toMatch(/^type:\s+\S/m);
    expect(metadata).toMatch(/^title:\s+\S/m);
    expect(metadata).toMatch(/^description:\s+\S/m);
    expect(metadata).toMatch(/^status:\s+draft$/m);
    expect(metadata).toMatch(/^generated:\n\s+by:\s+sheltie-okf-compaction\/0\.1\.0$/m);

    const resources = sourceResources(metadata);
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(resource).toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(resource).not.toMatch(/^file:/i);
      expect(resource).not.toContain(fixture.root);
      expect(resource).not.toContain("node-0123456789abcdef");
    }

    expect(concept).toContain(markerContent);
    expect(concept).not.toContain("<sheltie-okf>");
    expect(concept).not.toContain("</sheltie-okf>");
    expect(concept).not.toContain("RAW_TRANSCRIPT_DO_NOT_PERSIST");
    expect(concept).not.toContain("RAW_TRANSCRIPT_SUFFIX_DO_NOT_PERSIST");
    expect(concept).not.toContain("api_key=outside-marker");
    expect(concept).not.toContain("terminal_id=outside-marker");
    expect(concept).not.toContain("[[");

    const firstConcept = readFileSync(conceptPath, "utf8");
    await api.emit("session_compact", compactedEvent(summary));
    expect(conceptNames(fixture.outputDir)).toEqual([conceptName]);
    expect(readFileSync(conceptPath, "utf8")).toBe(firstConcept);

    await api.emit("auto_compaction_end", automaticEnd());
    await api.emit("session_compact", compactedEvent(summaryWithMarker("# Ignored after automatic end")));
    expect(conceptNames(fixture.outputDir)).toEqual([conceptName]);
  });

  test("does not emit an OKF bundle for manual compaction", async () => {
    const fixture = createFixture();
    const api = await loadExtension(fixture.outputDir);

    expect(await api.emit("session.compacting", compactingEvent())).toBeUndefined();
    await api.emit("session_compact", compactedEvent(summaryWithMarker("# Manual compaction must not emit")));

    expect(conceptNames(fixture.outputDir)).toEqual([]);
    expect(existsSync(join(fixture.outputDir, "index.md"))).toBe(false);
  });

  test("fails closed for credential, path, runtime-ID, JWT, and opaque marker content without a partial concept", async () => {
    const unsafeMarkerContents = [
      "# Unsafe credential\n\napi_key=sk-test-not-a-real-secret",
      "# Unsafe absolute path\n\nfile:///private-state/runtime/okf-compaction/node-0123456789abcdef.yml",
      "# Unsafe relative path\n\nRead ./private-state/runtime/okf-compaction/index.md",
      "# Unsafe tilde path\n\nRead ~/private-state/runtime/okf-compaction/index.md",
      "# Unsafe SSH path\n\nssh://operator@host.example/private-state/runtime/okf-compaction/index.md",
      "# Unsafe SCP-style path\n\noperator@host.example:private-state/runtime/okf-compaction/index.md",
      "# Unsafe UUID\n\n550e8400-e29b-41d4-a716-446655440000",
      "# Unsafe runtime ID\n\nruntime-0123456789abcdef",
      "# Unsafe JWT\n\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signed-token-value",
      "# Unsafe opaque value\n\nopaque_0123456789abcdef0123456789abcdef0123456789abcdef",
      "# Unsafe runtime identity\n\nterminal_id=terminal-123\nworkspace_id=workspace-123\nagent_instance_id=instance-123",
    ];

    for (const content of unsafeMarkerContents) {
      const fixture = createFixture();
      const api = await loadExtension(fixture.outputDir);
      await api.emit("auto_compaction_start", automaticStart());
      markerInstruction(await api.emit("session.compacting", compactingEvent()));
      await api.emit("session_compact", compactedEvent(summaryWithMarker(content)));
      await api.emit("auto_compaction_end", automaticEnd());

      expect(conceptNames(fixture.outputDir)).toEqual([]);
      expect(existsSync(join(fixture.outputDir, "index.md"))).toBe(false);
    }
  });

  test("publishes concurrent automatic concepts through immutable files and a byte-stable static index", async () => {
    const fixture = createFixture();
    const api = await loadExtension(fixture.outputDir);
    const contents = [
      "# First concurrent concept\n\nThe first automatic compaction completed.",
      "# Second concurrent concept\n\nThe second automatic compaction completed.",
    ];

    await api.emit("auto_compaction_start", automaticStart());
    await Promise.all(
      contents.map((content) => api.emit("session_compact", compactedEvent(summaryWithMarker(content)))),
    );

    const expectedNames = contents
      .map((content) => `compaction-${createHash("sha256").update(content, "utf8").digest("hex")}.md`)
      .sort();
    expect(conceptNames(fixture.outputDir)).toEqual(expectedNames);
    for (const content of contents) {
      const conceptName = `compaction-${createHash("sha256").update(content, "utf8").digest("hex")}.md`;
      expect(readFileSync(join(fixture.outputDir, "concepts", conceptName), "utf8")).toContain(content);
    }

    const staticIndex = readFileSync(join(fixture.outputDir, "index.md"), "utf8");
    expect(staticIndex).toMatch(/^---\nokf_version:\s*["']?0\.2["']?\n---/);
    expect(staticIndex).toContain("[Content-addressed concepts](./concepts/)");
    for (const name of expectedNames) expect(staticIndex).not.toContain(name);
    expect(existsSync(join(fixture.outputDir, ".okf-compaction.lock"))).toBe(false);

    await Promise.all(
      contents.map((content) => api.emit("session_compact", compactedEvent(summaryWithMarker(content)))),
    );
    expect(readFileSync(join(fixture.outputDir, "index.md"), "utf8")).toBe(staticIndex);
  });

  test("does not accept a same-hash concept whose existing bytes conflict", async () => {
    const fixture = createFixture();
    const api = await loadExtension(fixture.outputDir);
    const content = "# Canonical content";
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    const conceptPath = join(fixture.outputDir, "concepts", `compaction-${digest}.md`);

    mkdirSync(join(fixture.outputDir, "concepts"), { recursive: true, mode: 0o700 });
    writeFileSync(conceptPath, "conflicting concept bytes", { encoding: "utf8", mode: 0o600 });

    await api.emit("auto_compaction_start", automaticStart());
    await api.emit("session_compact", compactedEvent(summaryWithMarker(content)));

    expect(readFileSync(conceptPath, "utf8")).toBe("conflicting concept bytes");
    expect(existsSync(join(fixture.outputDir, "index.md"))).toBe(false);
  });
});
