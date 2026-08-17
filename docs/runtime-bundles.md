# Runtime bundles

A runtime bundle is the default local execution mode for Sheltie on Linux x64. It makes the executable, Herdr runtime, OMP runtime, and automatic-compaction extension one verified unit rather than relying on commands installed elsewhere on `PATH`.

## Flat layout and integrity

A bundle directory contains exactly this manifest and its flat sibling artifacts:

```text
<bundle-root>/
  runtime-manifest.json
  sheltie
  herdr
  omp
  sheltie-okf-compaction.js
```

`runtime-manifest.json` records the API version, target (`linux-x64`), artifact-reported source commits, Herdr version/protocol, and SHA-256 identity for every artifact. Artifact entries are relative basenames only; traversal and symlinked artifacts are rejected. Resolution canonicalizes the selected bundle root with `realpath(2)` before constructing, verifying, or persisting any artifact path, then verifies the manifest and every artifact hash before use.

The bundle must contain **both Herdr and OMP**. v0 accepts only an artifact that reports Herdr commit `ea766d5a70d53ad66028d980fb43b5808947ea71` or OMP commit `90fd6477137fc38c5257f11ad13d9b031b39c526`; a different full source SHA is incompatible. Bundled Herdr sets its server-owned `HERDR_AGENT_OMP_PATH` to the verified OMP absolute artifact path, so `agent.kind: omp` commands launch that exact executable even if interactive-shell startup rewrites `PATH`. Bundled mode also prepends the verified bundle root to `PATH` for subordinate commands launched by OMP; it never falls back to ambient `herdr` or `omp`.

## Build a bundle

First run the ordinary build, then use the builder with the exact binary artifacts:

```bash
bun run build
bun scripts/build-runtime-bundle.ts \
  --herdr-bin /path/to/herdr \
  --omp-bin /path/to/omp \
  --output ./sheltie-runtime
```

Before probing, the builder privately copies all four input artifacts into a temporary directory beneath a trusted output parent. It invokes `--build-info` only on the staged Herdr and OMP artifacts and accepts only stdout containing one JSONL object with schema `sheltie.runtime-build-info/v1` and no other output. Herdr must report `name: "herdr"`, version `0.8.0`, protocol `20`, and its required source commit; OMP must report `name: "omp"`, a semantic version, and its required source commit. Both probes start concurrently, and the builder waits for both to settle before reporting either failure. It rejects malformed, multiline, or extra output, incompatible records, nonzero exits, and timeouts; timeout or probe failure terminates and awaits each exact child, escalating from `SIGTERM` to `SIGKILL`.

After both probes validate, the builder hashes the staged artifacts and atomically renames that exact directory into the final bundle. On any failure it removes the staging directory and leaves no bundle output. There are no source-commit arguments: manifest `sourceCommit` values come only from the validated artifact records. The SHA-256 recorded for each artifact therefore binds that artifact-reported claim to the exact published bytes. This validates the bytes' embedded claim, not the authenticity of the build pipeline that produced them; obtain the binaries through a separately trusted build and distribution path. The equivalent package entry point is `bun run build:bundle -- --herdr-bin … --omp-bin …`. `bun run build` stays independent of runtime artifacts.

The builder verifies identity and target metadata but does not make dynamically linked binaries portable. Supply artifacts built for the destination Linux environment, or statically linked/otherwise self-contained artifacts when the bundle must move between hosts. A Devbox/Nix-linked local binary may depend on that machine’s Nix store and is suitable for local smoke use only; the manifest hash does not embed missing loader or shared-library dependencies.

## Selecting a runtime

Run the `sheltie` executable from a bundle and omit `--herdr-socket` to use bundled mode:

```bash
./sheltie-runtime/sheltie run start \
  --manifest examples/research-team/sheltie.yaml \
  --repo . \
  --state .sheltie-state
```

`--runtime-dir PATH` selects a non-adjacent bundle directory and is valid only in bundled mode. Its canonical real path becomes the persisted bundle root; intermediate symlink spellings are never persisted. Selection is deliberately unambiguous:

- no `--herdr-socket` selects bundled mode;
- a supplied `--herdr-socket` selects external mode unless `--runtime` says otherwise;
- `--runtime bundled` rejects `--herdr-socket`;
- `--runtime external` requires `--herdr-socket`;
- `--runtime-dir` with external mode is rejected.

External mode remains available for a pre-existing session:

```bash
./dist/sheltie run start \
  --runtime external \
  --manifest examples/research-team/sheltie.yaml \
  --repo . \
  --herdr-socket "$HERDR_SOCKET" \
  --state .sheltie-state
```

## Ownership and recovery

For a bundled run, Sheltie derives a unique named Herdr session, a private XDG configuration home, socket path, `HERDR_AGENT_OMP_PATH` binding to the verified absolute OMP artifact, controlled `PATH`, and a complete runtime identity from the run state. It starts that exact session with `herdr --session <unique> server`; its process ID is only an observation, never ownership proof. The persisted binding is authoritative. Nested Sheltie commands use the binding’s verified `sheltie` path, and automatic compaction stages the binding’s verified extension path, including when the selected bundle is not adjacent to the caller executable.

The XDG configuration home is a short owner-private path under `${tmpdir()}/sheltie-herdr-<uid>/<hash>`, not below the state directory. Its hash binds the resolved state root, bundle digest, and normalized run ID; the binding persists the resulting absolute configuration home and socket path. Resume validates current canonical bundle identity against those persisted values without recomputing them, so a later `TMPDIR` change cannot redirect or invalidate the run. This keeps the named-session socket below the Unix path ceiling while preserving collision-safe ownership, and keeps that run’s Herdr stdout/stderr logs in the same configuration home.

Resume, cancellation, quiescing, cleanup, and reconciliation resolve the persisted canonical bundle root again and require its target, manifest digest, artifact hashes, artifact paths, versions, protocols, and exact source commits to match the binding. They do not derive executable, extension, configuration, session, or socket paths from the current caller. The Herdr server environment strips inherited `HERDR_*` variables, then sets `HERDR_AGENT_OMP_PATH` to the exact OMP artifact and prefixes `PATH`. Workspace and tab creation receive only that controlled `PATH`; credentials and unrelated process environment are not copied into SQLite operation requests. The override is set only in bundled mode, and external mode keeps the caller executable and its normal sibling-extension lookup.

If a newly spawned detached Herdr does not become ready, Sheltie terminates and awaits that exact child before reporting startup failure, escalating from `SIGTERM` to `SIGKILL` after a bounded grace period. A bundled startup failure before tree reservation also stops the task-owned named session; after reservation, the run and session remain available for resume and reconciliation.

`run cleanup --apply` stops the bundled named session only after cleanup has successfully marked the tree `cleaned`. Repeating cleanup reconciles an already-stopped named session. Sheltie never starts or stops an external socket, default Herdr session, or foreign session.

Automatic OKF compaction serializes writes with an owner-private, no-symlink lock containing the owner PID, Linux process start token, and a random owner token. A lock is reclaimed only when `/proc` demonstrates that the recorded process no longer exists or that its PID was reused. Live locks and locks whose ownership cannot be proved remain untouched, and release removes only the unchanged lock created by that owner. This prevents a crashed compaction process from permanently wedging later precommits without allowing an ambiguous lock to be stolen.

Use the runtime commands against persisted state:

```bash
./sheltie-runtime/sheltie runtime status --state .sheltie-state
./sheltie-runtime/sheltie runtime stop --state .sheltie-state
./sheltie-runtime/sheltie runtime attach --state .sheltie-state
```

Normal `runtime status` reports only safe state and compatibility facts. `--unsafe-output` exposes machine-local runtime details. `attach` is bundled-only and delegates terminal interaction to the exact bundled Herdr binary and persisted named session; external runtimes have no Sheltie-owned session to attach or stop.

## Scope and security boundary

v0 supports Linux x64 only. There is no ambient-command fallback and no cross-platform bundle target in this release. Bundle permissions, canonical paths, hashes, owner-private state, and owner-token locks protect against accidental drift and mutation by other Unix users. Deliberate mutation by another process running as the same Unix user remains outside the hard security boundary; use a dedicated account or stronger host isolation when same-user code is not trusted.
