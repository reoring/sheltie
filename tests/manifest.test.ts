import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestValidationError, parseResolvedManifest, resolveManifestFile } from "../src/manifest.ts";
import { requestHash } from "../src/ids.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(manifest: string): { root: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), "sheltie-manifest-"));
  roots.push(root);
  mkdirSync(join(root, "prompts"));
  writeFileSync(join(root, "prompts", "root.md"), "Coordinate one team.\n");
  const manifestPath = join(root, "sheltie.yaml");
  writeFileSync(manifestPath, manifest);
  return { root, manifestPath };
}

function validationErrorFor(manifest: string): ManifestValidationError {
  const { manifestPath } = fixture(manifest);
  try {
    resolveManifestFile(manifestPath);
  } catch (error) {
    if (error instanceof ManifestValidationError) return error;
    throw error;
  }
  throw new Error("expected manifest validation to fail");
}

const VALID_MANIFEST = `apiVersion: sheltie.dev/v1alpha1
kind: Run
metadata:
  name: manifest-poc
spec:
  root:
    role: coordinator
    name: root
  limits:
    maxDepth: 4
    maxChildrenPerNode: 8
    maxDescendants: 32
    maxParallelNodes: 8
  roles:
    coordinator:
      placement: workspace
      agent:
        kind: omp
      prompt:
        file: prompts/root.md
      capabilities:
        spawn:
          roles: [team]
        mergeChildren: true
        messaging:
          sendTo: [children]
          receiveFrom: [children]
    team:
      placement: workspace
      agent:
        kind: omp
      prompt:
        inline: |
          Create the team result.
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent]
`;

const TEAM_RESEARCHER_REVIEWER_MANIFEST = `${VALID_MANIFEST
  .replace("\n    team:\n", "\n    researcher:\n")
  .replace("roles: [team]", "roles: [researcher, reviewer]")
  .replace("role: coordinator", "role: team")
  .replace("\n    coordinator:\n", "\n    team:\n")}
    reviewer:
      placement: workspace
      agent:
        kind: omp
      prompt:
        inline: |
          Review the research result.
      capabilities:
        spawn:
          roles: []
        mergeChildren: false
        messaging:
          sendTo: [parent]
          receiveFrom: [parent]
`;

const COMPACTION_CAPABLE_MANIFEST = TEAM_RESEARCHER_REVIEWER_MANIFEST
  .replace("roles: []", "roles: [reviewer]")
  .replace("receiveFrom: [parent]", "receiveFrom: [parent, children]");

const RESERVED_OMP_COMPACTION_ARGUMENTS = [
  ["--"],
  ["--config", "/tmp/untrusted"],
  ["--config=/tmp/untrusted"],
  ["--extension", "/tmp/untrusted"],
  ["--extension=/tmp/untrusted"],
  ["--trusted-extension", "/tmp/untrusted"],
  ["--trusted-extension=/tmp/untrusted"],
  ["--plugin-dir", "/tmp/untrusted"],
  ["--plugin-dir=/tmp/untrusted"],
  ["--profile", "untrusted"],
  ["--profile=untrusted"],
  ["-e", "/tmp/untrusted"],
  ["-e=/tmp/untrusted"],
  ["--hook", "/tmp/untrusted"],
  ["--hook=/tmp/untrusted"],
] as const;

function compactionPolicy(roles: string, thresholdPercent: number | string = 60): string {
  return `    compaction:
      format: okf-v0.2
      roles: ${roles}
      thresholdPercent: ${thresholdPercent}
`;
}

function withCompaction(manifest: string, compaction: string): string {
  return manifest.replace("  roles:\n", `  knowledge:\n${compaction}  roles:\n`);
}

describe("declarative run manifest", () => {
  test("resolves prompts and capabilities into one deterministic digest", () => {
    const { manifestPath } = fixture(VALID_MANIFEST);

    const first = resolveManifestFile(manifestPath);
    const second = resolveManifestFile(manifestPath);

    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.digest).toBe(first.digest);
    expect(first.manifest.metadata.name).toBe("manifest-poc");
    expect(first.manifest.spec.root).toEqual({ role: "coordinator", name: "root" });
    expect(first.manifest.spec.roles.coordinator).toMatchObject({
      placement: "workspace",
      prompt: { content: "Coordinate one team.\n" },
      capabilities: {
        spawn: { roles: ["team"] },
        mergeChildren: true,
        messaging: { sendTo: ["children"], receiveFrom: ["children"] },
      },
    });
    expect(first.manifest.spec.roles.team!.prompt.content).toBe("Create the team result.\n");
    expect(first.digest).toBe(requestHash(first.manifest));
    expect(first.canonicalJson).toBe(second.canonicalJson);
  });

  test("rejects team sends that spawned researcher and reviewer roles do not accept", () => {
    const error = validationErrorFor(
      TEAM_RESEARCHER_REVIEWER_MANIFEST.replaceAll("receiveFrom: [parent]", "receiveFrom: []"),
    );

    expect(error.issues).toEqual([
      {
        path: "spec.roles.researcher.capabilities.messaging.receiveFrom",
        message: 'must include parent because parent role "team" sends to children',
      },
      {
        path: "spec.roles.reviewer.capabilities.messaging.receiveFrom",
        message: 'must include parent because parent role "team" sends to children',
      },
    ]);
  });

  test("rejects spawned child sends that their team parent does not accept", () => {
    const error = validationErrorFor(
      TEAM_RESEARCHER_REVIEWER_MANIFEST.replace(
        "sendTo: [children]\n          receiveFrom: [children]",
        "sendTo: [children]\n          receiveFrom: []",
      ),
    );

    expect(error.issues).toEqual([
      {
        path: "spec.roles.team.capabilities.messaging.receiveFrom",
        message: 'must include children because child role "researcher" sends to parent',
      },
      {
        path: "spec.roles.team.capabilities.messaging.receiveFrom",
        message: 'must include children because child role "reviewer" sends to parent',
      },
    ]);
  });

  test("accepts bidirectional and receive-only messaging across spawned roles", () => {
    const bidirectional = fixture(TEAM_RESEARCHER_REVIEWER_MANIFEST);
    const resolved = resolveManifestFile(bidirectional.manifestPath);

    expect(resolved.manifest.spec.roles.team!.capabilities.messaging).toEqual({
      sendTo: ["children"],
      receiveFrom: ["children"],
    });
    expect(resolved.digest).toBe(requestHash(resolved.manifest));

    const receiveOnly = fixture(
      TEAM_RESEARCHER_REVIEWER_MANIFEST.replace(
        "sendTo: [parent]\n          receiveFrom: [parent]",
        "sendTo: []\n          receiveFrom: [parent]",
      ),
    );
    expect(() => resolveManifestFile(receiveOnly.manifestPath)).not.toThrow();
  });

  test("sorts multiple messaging-symmetry issues by their receiving capability path", () => {
    const error = validationErrorFor(
      TEAM_RESEARCHER_REVIEWER_MANIFEST
        .replace(
          "sendTo: [children]\n          receiveFrom: [children]",
          "sendTo: [children]\n          receiveFrom: []",
        )
        .replaceAll("receiveFrom: [parent]", "receiveFrom: []"),
    );

    expect(error.issues).toEqual([
      {
        path: "spec.roles.researcher.capabilities.messaging.receiveFrom",
        message: 'must include parent because parent role "team" sends to children',
      },
      {
        path: "spec.roles.reviewer.capabilities.messaging.receiveFrom",
        message: 'must include parent because parent role "team" sends to children',
      },
      {
        path: "spec.roles.team.capabilities.messaging.receiveFrom",
        message: 'must include children because child role "researcher" sends to parent',
      },
      {
        path: "spec.roles.team.capabilities.messaging.receiveFrom",
        message: 'must include children because child role "reviewer" sends to parent',
      },
    ]);
  });

  test("collects independent document, role, prompt, and cross-reference errors in a stable order", () => {
    const invalidManifest = VALID_MANIFEST
      .replace("apiVersion: sheltie.dev/v1alpha1", "apiVersion: sheltie.dev/v1beta1")
      .replace("placement: workspace", "placement: invalid")
      .replace("kind: omp", "kind: omp\n        model: hidden")
      .replace("file: prompts/root.md", "file: prompts/missing.md")
      .replace("    team:\n      placement: workspace", "    team:\n      placement: invalid")
      .replace("roles: [team]", "roles: [missing]");

    const error = validationErrorFor(invalidManifest);

    expect(error.issues).toEqual([
      { path: "apiVersion", message: "expected sheltie.dev/v1alpha1" },
      { path: "spec.roles.coordinator.agent.model", message: "unknown field" },
      { path: "spec.roles.coordinator.placement", message: "expected workspace or tab" },
      {
        path: "spec.roles.coordinator.prompt.file",
        message: "prompt file does not exist: prompts/missing.md",
      },
      { path: "spec.roles.team.placement", message: "expected workspace or tab" },
      {
        path: "spec.roles.coordinator.capabilities.spawn.roles[0]",
        message: 'role "missing" does not exist',
      },
    ]);
    expect(error.message).toBe(
      `manifest validation failed
apiVersion: expected sheltie.dev/v1alpha1
spec.roles.coordinator.agent.model: unknown field
spec.roles.coordinator.placement: expected workspace or tab
spec.roles.coordinator.prompt.file: prompt file does not exist: prompts/missing.md
spec.roles.team.placement: expected workspace or tab
spec.roles.coordinator.capabilities.spawn.roles[0]: role "missing" does not exist`,
    );
  });

  test("rejects explicit keys, anchors, aliases, tags, and recursive aliases before YAML parsing", () => {
    const unsupported = [
      {
        manifest: "? apiVersion\n: sheltie.dev/v1alpha1\n",
        message: "quoted and explicit YAML mapping keys are not supported",
      },
      {
        manifest: "apiVersion: &version sheltie.dev/v1alpha1\n",
        message: "YAML anchors, aliases, and tags are not supported",
      },
      {
        manifest: "apiVersion: *version\n",
        message: "YAML anchors, aliases, and tags are not supported",
      },
      {
        manifest: "apiVersion: !version sheltie.dev/v1alpha1\n",
        message: "YAML anchors, aliases, and tags are not supported",
      },
      {
        manifest: "node: &node\n  self: *node\n",
        message: "YAML anchors, aliases, and tags are not supported",
      },
    ];

    for (const { manifest, message } of unsupported) {
      const error = validationErrorFor(manifest);
      expect(error.issues).toEqual([{ path: "manifest:1", message }]);
      expect(error.message).toBe(`manifest validation failed\nmanifest:1: ${message}`);
    }
  });

  test("reports invalid YAML as one boundary issue", () => {
    const error = validationErrorFor('apiVersion: "unterminated');

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toBe("manifest");
    expect(error.message).toStartWith("manifest validation failed\nmanifest: invalid YAML:");

  });

  test("reports source-read failure as one boundary issue", () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-manifest-missing-"));
    roots.push(root);
    let thrown: unknown = undefined;
    try {
      resolveManifestFile(join(root, "missing.yaml"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestValidationError);
    const error = thrown as ManifestValidationError;
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toBe("manifest");
  });
  test("rejects unknown roles, unknown fields, and duplicate mapping keys", () => {
    const missingRole = fixture(VALID_MANIFEST.replace("roles: [team]", "roles: [missing]"));
    expect(() => resolveManifestFile(missingRole.manifestPath)).toThrow(
      'spec.roles.coordinator.capabilities.spawn.roles[0]: role "missing" does not exist',
    );

    const unknownField = fixture(VALID_MANIFEST.replace("kind: omp", "kind: omp\n        model: hidden"));
    expect(() => resolveManifestFile(unknownField.manifestPath)).toThrow(
      "spec.roles.coordinator.agent.model: unknown field",
    );

    const duplicateKey = fixture(VALID_MANIFEST.replace("name: manifest-poc", "name: manifest-poc\n  name: drift"));
    expect(() => resolveManifestFile(duplicateKey.manifestPath)).toThrow(
      "metadata.name: duplicate YAML mapping key",
    );
    const quotedDuplicate = fixture(VALID_MANIFEST.replace("name: manifest-poc", "name: manifest-poc\n  \"name\": drift"));
    expect(() => resolveManifestFile(quotedDuplicate.manifestPath)).toThrow(
      "quoted and explicit YAML mapping keys are not supported",
    );
  });


  test("resolves one canonical OKF compaction policy and includes it in the manifest digest", () => {
    const firstFixture = fixture(
      withCompaction(COMPACTION_CAPABLE_MANIFEST, compactionPolicy("[team, researcher]", 10)),
    );
    const secondFixture = fixture(
      withCompaction(COMPACTION_CAPABLE_MANIFEST, compactionPolicy("[researcher, team]", 10)),
    );

    const first = resolveManifestFile(firstFixture.manifestPath);
    const second = resolveManifestFile(secondFixture.manifestPath);

    expect(first.manifest).toMatchObject({
      spec: {
        knowledge: {
          compaction: {
            format: "okf-v0.2",
            roles: ["researcher", "team"],
            thresholdPercent: 10,
          },
        },
      },
    });
    expect(second.manifest).toEqual(first.manifest);
    expect(first.digest).toBe(requestHash(first.manifest));
    expect(second.digest).toBe(first.digest);
    expect(second.canonicalJson).toBe(first.canonicalJson);
  });

  test("rejects an empty compaction role selection", () => {
    const error = validationErrorFor(
      withCompaction(COMPACTION_CAPABLE_MANIFEST, compactionPolicy("[]")),
    );

    expect(error.issues).toEqual([
      {
        path: "spec.knowledge.compaction.roles",
        message: "expected at least one role",
      },
    ]);
  });

  test("rejects unknown, leaf, non-OMP, and duplicate compaction roles", () => {
    const cases = [
      {
        manifest: withCompaction(COMPACTION_CAPABLE_MANIFEST, compactionPolicy("[missing]")),
        issue: {
          path: "spec.knowledge.compaction.roles[0]",
          message: 'role "missing" does not exist',
        },
      },
      {
        manifest: withCompaction(COMPACTION_CAPABLE_MANIFEST, compactionPolicy("[reviewer]")),
        issue: {
          path: "spec.knowledge.compaction.roles[0]",
          message: 'role "reviewer" must be the root role or have one or more spawn roles',
        },
      },
      {
        manifest: withCompaction(
          VALID_MANIFEST.replace("kind: omp", "kind: shell"),
          compactionPolicy("[coordinator]"),
        ),
        issue: {
          path: "spec.knowledge.compaction.roles[0]",
          message: 'role "coordinator" must use agent.kind omp',
        },
      },
      {
        manifest: withCompaction(COMPACTION_CAPABLE_MANIFEST, compactionPolicy("[team, team]")),
        issue: {
          path: "spec.knowledge.compaction.roles",
          message: "duplicate role",
        },
      },
    ];

    for (const { manifest, issue } of cases) {
      expect(validationErrorFor(manifest).issues).toEqual([issue]);
    }
  });

  test("accepts only integer compaction thresholds from 10 through 95", () => {
    for (const thresholdPercent of [10, 95]) {
      const { manifestPath } = fixture(
        withCompaction(COMPACTION_CAPABLE_MANIFEST, compactionPolicy("[team]", thresholdPercent)),
      );
      expect(resolveManifestFile(manifestPath).manifest).toMatchObject({
        spec: { knowledge: { compaction: { thresholdPercent } } },
      });
    }

    for (const thresholdPercent of [9, 95.5, 96]) {
      const error = validationErrorFor(
        withCompaction(COMPACTION_CAPABLE_MANIFEST, compactionPolicy("[team]", thresholdPercent)),
      );
      expect(error.issues).toEqual([
        {
          path: "spec.knowledge.compaction.thresholdPercent",
          message: "expected an integer from 10 to 95",
        },
      ]);
    }
  });

  test("rejects unknown fields in knowledge compaction policy", () => {
    const error = validationErrorFor(
      withCompaction(
        COMPACTION_CAPABLE_MANIFEST,
        `    unexpected: true
    compaction:
      format: okf-v0.2
      roles: [team]
      thresholdPercent: 60
      extra: true
`,
      ),
    );

    expect(error.issues).toEqual([
      { path: "spec.knowledge.compaction.extra", message: "unknown field" },
      { path: "spec.knowledge.unexpected", message: "unknown field" },
    ]);
  });

  test("rejects reserved compaction controls for selected roles without changing unselected roles", () => {
    const reservedArguments = [
      "--sheltie-okf-dir=/tmp/untrusted",
      ...RESERVED_OMP_COMPACTION_ARGUMENTS.flat(),
    ];
    const unselected = resolveManifestFile(
      fixture(
        withCompaction(
          COMPACTION_CAPABLE_MANIFEST.replace(
            "    reviewer:\n      placement: workspace\n      agent:\n        kind: omp",
            `    reviewer:\n      placement: workspace\n      agent:\n        kind: omp\n        args: ${JSON.stringify(reservedArguments)}`,
          ),
          compactionPolicy("[team]"),
        ),
      ).manifestPath,
    );
    expect(unselected.manifest.spec.roles.reviewer?.agent.args).toEqual(reservedArguments);

    for (const arguments_ of RESERVED_OMP_COMPACTION_ARGUMENTS) {
      const error = validationErrorFor(
        withCompaction(
          COMPACTION_CAPABLE_MANIFEST.replace(
            "    team:\n      placement: workspace\n      agent:\n        kind: omp",
            `    team:\n      placement: workspace\n      agent:\n        kind: omp\n        args: ${JSON.stringify(arguments_)}`,
          ),
          compactionPolicy("[team]"),
        ),
      );
      expect(error.issues).toEqual([
        {
          path: "spec.roles.team.agent.args[0]",
          message: "reserved for knowledge compaction",
        },
      ]);
    }
  });

  test("rejects persisted reserved compaction controls for selected roles", () => {
    const { manifestPath } = fixture(COMPACTION_CAPABLE_MANIFEST);
    const base = resolveManifestFile(manifestPath).manifest;
    const team = base.spec.roles.team;
    if (team === undefined) throw new Error("expected team role");
    const persisted = {
      ...base,
      spec: {
        ...base.spec,
        knowledge: {
          compaction: {
            format: "okf-v0.2" as const,
            roles: ["team"],
            thresholdPercent: 60,
          },
        },
      },
    };

    for (const arguments_ of RESERVED_OMP_COMPACTION_ARGUMENTS) {
      expect(() =>
        parseResolvedManifest({
          ...persisted,
          spec: {
            ...persisted.spec,
            roles: {
              ...persisted.spec.roles,
              team: {
                ...team,
                agent: {
                  ...team.agent,
                  args: arguments_,
                },
              },
            },
          },
        }),
      ).toThrow(`resolved manifest.spec.roles.team.agent.args[0]: reserved for knowledge compaction`);
    }
  });

  test("validates persisted resolved compaction policies through parseResolvedManifest", () => {
    const { manifestPath } = fixture(COMPACTION_CAPABLE_MANIFEST);
    const base = resolveManifestFile(manifestPath).manifest;
    const persisted = {
      ...base,
      spec: {
        ...base.spec,
        knowledge: {
          compaction: {
            format: "okf-v0.2" as const,
            roles: ["researcher", "team"],
            thresholdPercent: 60,
          },
        },
      },
    };

    expect(parseResolvedManifest(persisted)).toEqual(persisted);
    expect(() =>
      parseResolvedManifest({
        ...persisted,
        spec: {
          ...persisted.spec,
          knowledge: {
            compaction: {
              format: "okf-v0.2",
              roles: ["researcher", "team"],
              thresholdPercent: 96,
            },
          },
        },
      }),
    ).toThrow("resolved manifest.spec.knowledge.compaction.thresholdPercent: expected an integer from 10 to 95");
  });

  test("rejects prompt paths that escape the manifest directory", () => {
    const { root, manifestPath } = fixture(VALID_MANIFEST.replace("prompts/root.md", "../outside.md"));
    writeFileSync(join(root, "..", "outside.md"), "outside\n");

    expect(() => resolveManifestFile(manifestPath)).toThrow(
      "spec.roles.coordinator.prompt.file: path must remain inside the manifest directory",
    );
  });
});
