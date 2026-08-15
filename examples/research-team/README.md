# Research-team example

This is a portable, experimental local PoC showing a four-role Sheltie run. Run the commands below from the repository root. The example uses the canonical [`sheltie.yaml`](sheltie.yaml) manifest and its role prompts: [`coordinator.md`](prompts/coordinator.md), [`team.md`](prompts/team.md), [`researcher.md`](prompts/researcher.md), and [`reviewer.md`](prompts/reviewer.md).

## Topology

```text
coordinator (workspace)
        |
        v
team (isolated workspace)
    /              \
researcher       reviewer
(read-only tab)  (read-only tab)
```

- **coordinator** starts one `team` child and owns the final synthesis.
- **team** turns the question into an evidence packet, then starts one `researcher` and one `reviewer`.
- **researcher** investigates the question and reports evidence.
- **reviewer** checks the research packet for support, gaps, alternatives, and residual risk.


The coordinator and team use separate workspaces. The two tab roles share the team workspace and branch, so their findings return through the durable inbox rather than through file changes. After both tabs finish, the read-write `team` child writes the reviewed packet to the small named artifact `research-team-final.md`, commits exactly that artifact, and completes its step at the new commit. The coordinator may then merge that completed workspace child, bringing the artifact into the coordinator branch. The researcher and reviewer complete at their unchanged `HEAD`; they never write, commit, or merge. The example demonstrates manifest-declared placement and capabilities, durable `progress` versus final `result` messages, completion ordering, and the different merge behavior for workspace and tab children.
The private `.sheltie-state/` directory is runtime state, not a team artifact. It is ignored by the repository, so starting the example with `--state .sheltie-state` does not dirty the clean root worktree.

## Automatic compaction knowledge

`spec.knowledge.compaction` selects `coordinator` and `team` at `thresholdPercent: 70` using `okf-v0.2`. Selection is limited to unique OMP roles that are the root or can spawn children; `researcher` and `reviewer` are leaf roles and remain unselected.

Selected roles use an owner-private `context-full` overlay with `remoteEnabled: false`, `thresholdPercent: 70`, `thresholdTokens: -1`, and `autoContinue: true`; OMP uses local context-full summarization and honors `session.compacting` marker context. The configured automatic-compaction extension is staged as a private copy before OMP starts, and only that staged extension is passed to OMP.

During an automatic compaction, only the bounded `<sheltie-okf>...</sheltie-okf>` marker is considered. Each selected node gets a private OKF v0.2 bundle containing `index.md` and an idempotent `concepts/compaction-<digest>.md` draft concept. Concepts are private, unverified drafts with portable non-file provenance, not SQLite/run authority; the raw surrounding summary or raw transcript is never copied.

Pattern screening is bounded and best-effort, not exhaustive path, credential, runtime-ID, or secret detection. Empty or oversized marker content, wikilinks, traversal/tilde/SSH path signals, credential-like patterns, JWTs, runtime IDs or UUIDs, and long token/hash-like values produce no partial concept. Processes running as the same Unix user remain outside Sheltie's hard security boundary. Knowledge or extension write failures are logged and do not abort compaction, so artifact emission may be skipped. Cleanup preserves knowledge bundles.

## Mergeable team artifact

`research-team-final.md` is created in the team workspace only after the researcher and reviewer return their final results. It contains the concise reviewed packet and is the team's one authorized commit. The coordinator merges the completed team workspace through the generated protocol; the two read-only tabs remain unmerged because they share that workspace.

## Prerequisites

- Bun **1.3.13**, Git, and a clean disposable checkout.
- A compatible local Herdr runtime (Herdr **0.8.0**, protocol **20**) with a reachable Unix socket. Set its path in the generic `$HERDR_SOCKET` variable.
- An OMP Agent runtime that Herdr can start for the manifest roles.
- The repository-built executable at `./dist/sheltie` and its sibling automatic-compaction extension at `./dist/sheltie-okf-compaction.js`.

From the repository root, install dependencies and build the executable if needed:

```bash
bun install
bun run build
```

## Validate and start

Validate the canonical manifest before starting:

```bash
./dist/sheltie manifest validate \
  --file examples/research-team/sheltie.yaml
```

Start from the clean disposable checkout. Sheltie creates the private state directory when it is missing:

```bash
./dist/sheltie run start \
  --manifest examples/research-team/sheltie.yaml \
  --repo . \
  --herdr-socket "$HERDR_SOCKET" \
  --state .sheltie-state
```

## Status and observation

Use lifecycle and observation commands to inspect the run:

```bash
./dist/sheltie run status --state .sheltie-state
./dist/sheltie observe snapshot --state .sheltie-state
```

## Cleanup

Cleanup is operator-sensitive. The default preview returns the exact plan digest and aggregate counts without machine-local targets. Inspect those exact targets only through an explicit unsafe preview, then apply the reviewed plan with its digest:

```bash
./dist/sheltie run cleanup --state .sheltie-state
./dist/sheltie run cleanup --state .sheltie-state --unsafe-output
./dist/sheltie run cleanup \
  --state .sheltie-state \
  --apply \
  --plan-digest "$PLAN_DIGEST"
```

`$PLAN_DIGEST` is the digest returned by the preview. Unsafe output can contain paths and runtime identifiers; do not share it. Do not replace the preview with a broad removal command or apply a digest from another plan.

## Completion protocol

A `progress` message is an interim update; it never establishes completion. For each non-root Agent, the generated protocol performs these actions in order:

```text
step complete -> node finish -> send the final result message
```

The parent waits for that completed node and its final `result` before making completion-dependent decisions. A completed workspace child may then be merged through the generated protocol. Tab children are never merged because they share the team workspace.

This sequence is Agent protocol behavior supplied by the generated prompts. Ordinary users should not run Agent protocol commands manually; use the lifecycle and observation commands above to operate and inspect the example.

## Read-only tabs

The `researcher` and `reviewer` roles are manifest-declared read-only tabs. They may inspect the shared team worktree and send findings, but they must not modify files or create commits. Their work is communicated through the inbox, not by changing the worktree; concurrent read-write tab work is outside this example.
