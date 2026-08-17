# Sheltie

Sheltie coordinates a manifest-declared team of OMP Agents in Herdr workspaces, using durable and capability-checked SQLite messaging rather than prompt text as its message transport.

> **Experimental local PoC.** Sheltie is for local, disposable research and development workflows. It is not production-ready, is not a hosted service, and must not be used as a hard security boundary.

## Why Sheltie exists

Sheltie started with a simple question: can one root coding Agent recursively form a team, delegate work to child Agents, and leave behind one reviewable Git result? The desired shape was fractal-style: a root could create an isolated team, that team could create local researchers or reviewers, and the system could durably report progress, finish nodes, merge isolated branches, and recover without a human reconstructing the run from terminal scrollback.

### Problem: a runtime layout is not an orchestration state

Herdr already provides the runtime primitives Sheltie needs: sessions, workspaces, tabs, panes, terminals, and Agent processes. Those objects answer **where an Agent is running**. They do not, by themselves, answer **why the Agent exists**, who its logical parent is, which operation created it, whether its result is final, or whether its branch was merged.

That distinction matters. Herdr workspaces are peers in the native UI, while a logical Agent tree may contain several nested levels. Prompt-only coordination is also transient: if a controller loses the response to a worktree creation, Agent start, or prompt submission, blindly repeating the request can duplicate work. A terminal that looks idle does not prove that a step completed, and a progress message does not prove that a child produced a mergeable result.

### Challenges: recovery, isolation, and authority

The design process and real runs exposed a mix of structural tradeoffs and concrete failure modes:

- Mapping every node to a workspace preserves Git isolation, but leaves collaboration visually flat. Mapping every child to a tab looks more hierarchical, but removes branch isolation and makes concurrent writes collide.
- The controller and Agent-facing CLI are concurrent users of the same state. An early run reproduced SQLite writer contention, so lock acquisition had to be bounded and retryable rather than assumed to succeed immediately.
- An external mutation can enter an uncertain-delivery state when the controller loses its response. Sheltie must reconcile durable operation identity with current runtime state before any retry, and fail closed when it cannot prove one owned effect.
- Completion needs a durable order. A child must complete its step, finish its node, and only then publish a final `result`; ordinary `progress` remains non-final.
- A role restriction written only in a prompt is guidance, not a capability boundary. Spawn, merge, placement, messaging, and concurrency limits must be checked by the controller before mutation.

### Solution: separate durable intent, runtime, and artifacts

Sheltie assigns each concern one authority:

- A strict YAML manifest declares roles, prompts, placement, allowed children, messaging relations, and controller-enforced capabilities before the first Herdr mutation.
- SQLite owns the logical parent-child tree, operation identities, lifecycle transitions, inbox messages, read receipts, and recovery evidence.
- Git owns durable artifacts: workspace children receive isolated branches and linked worktrees, while tab children share their parent's worktree. Tab work is cooperative and read-only by default; a write lease for concurrent read-write tabs is not implemented.
- Herdr owns the live execution projection. Sheltie creates and locates Agents there, but never infers the durable logical tree from sidebar order, labels, or pane layout.
- A versioned, allowlisted observation snapshot projects the SQLite state into the read-only Cockpit without exposing prompts, paths, sockets, Agent identities, or raw operation payloads.

The resulting protocol is intentionally conservative: reserve before mutating, reconcile before retrying, fail closed on ambiguous ownership, distinguish progress from completion, and preserve the root branch as the run's deliverable. Sheltie does not yet provide A2A transport, a daemon scheduler, concurrent read-write tabs, or a hard sandbox against processes running as the same Unix user.

## What it does

- Defines an Agent tree, prompts, placement, workspace policy, and messaging authority in a validated YAML manifest.
- Starts a root coordinator in a Herdr workspace; child roles use isolated workspaces or shared-worktree tabs as declared by the manifest.
- Uses a durable SQLite inbox for `progress` and final `result` messages, with manifest authorization checked at insertion time.
- Authenticates every Agent-facing state mutation against the live Herdr Agent identity before opening the writable state store.
- Projects a product-safe `ObservationSnapshot` and includes an optional read-only Herdr Cockpit.
- Requires an explicit, exact-target cleanup plan before removing run-owned runtime resources.

## Demo

This recording is a real bundled run: one coordinator starts researcher and reviewer OMP Agents in parallel tabs, receives both durable inbox results, completes the three-node tree, quiesces the Agents, and applies digest-bound cleanup.

[![Watch the Sheltie live demo](https://asciinema.org/a/DIAhNi9DD1vaC1v9.svg)](https://asciinema.org/a/DIAhNi9DD1vaC1v9)

The audited cast is also committed for local playback:

```bash
asciinema play demo/sheltie.cast
```

## Architecture

```text
validated manifest + prompt files
              |
              v
Sheltie lifecycle controller -----> Herdr workspaces, tabs, and OMP Agents
              |                                |
              |                                v
              +--> durable SQLite state <--- authenticated Agent commands
                       |
                       +--> safe ObservationSnapshot --> read-only Cockpit
```

Herdr creates and locates Agents; it is not the inter-Agent transport. Sheltie stores messages, completion state, and receipts in the run state, and it enforces the manifest's parent/child messaging rules when messages are sent.

## Compatibility

The runtime gate is intentionally exact. Sheltie supports the public [`reoring/herdr`](https://github.com/reoring/herdr/tree/dda3fb5a99752948c87214d79e8b218e3a5b4078) revision [`dda3fb5a99752948c87214d79e8b218e3a5b4078`](https://github.com/reoring/herdr/commit/dda3fb5a99752948c87214d79e8b218e3a5b4078), reporting **Herdr 0.8.0** and **protocol 20**. A runtime that reports another version or protocol is rejected.

## Prerequisites

- Bun **1.3.13**.
- Git and a clean, disposable source checkout. Starting a run creates or switches to a Sheltie root branch in that checkout.
- For the default bundled mode, a Linux-x64 runtime bundle containing exact Sheltie, Herdr, OMP, and the OKF compaction extension. Bundled mode never falls back to ambient `herdr` or `omp`.
- For explicit external mode, a compatible local Herdr runtime with a reachable Unix socket and an OMP runtime that it can start. Supply its socket path with `--herdr-socket`.

[Devbox](https://www.jetify.com/devbox) is optional and provides the pinned development environment.

## Install and build

Clone this repository and build the local executable; Sheltie is deliberately not presented as an npm package.

```bash
git clone https://github.com/reoring/sheltie.git
cd sheltie
bun install
bun run build
```

`bun run build` writes `dist/sheltie` and its sibling automatic-compaction extension `dist/sheltie-okf-compaction.js`; it does not require runtime inputs. To create a distributable Linux-x64 runtime bundle after that normal build, provide the exact Herdr and OMP binary artifacts. The builder accepts provenance only from each artifact's sole `--build-info` JSONL record; it does not accept source-commit flags.

```bash
bun scripts/build-runtime-bundle.ts \
  --herdr-bin /path/to/herdr \
  --omp-bin /path/to/omp \
  --output ./sheltie-runtime
```

The manifest records the validated embedded source claims and each copied artifact's SHA-256. The hash binds a reported claim to exact bytes, while trust in the build pipeline that produced those bytes is a separate decision. `bun run build:bundle -- --herdr-bin … --omp-bin …` is the equivalent build-script entry point. The output is a flat bundle; see [Runtime bundles](docs/runtime-bundles.md) for its layout and lifecycle.

## Automatic compaction knowledge

A manifest may opt a sorted, unique list of root or parent-capable `agent.kind: omp` roles into private automatic-compaction preservation:

```yaml
knowledge:
  compaction:
    format: okf-v0.2
    roles: [coordinator, team]
    thresholdPercent: 70
```

Selected roles receive an owner-private `context-full` overlay with `remoteEnabled: false`, the manifest threshold, `thresholdTokens: -1`, and `autoContinue: true`. The configured automatic-compaction extension is staged as a private copy before OMP starts, and only that staged extension is passed to OMP.

For each normal automatic `context-full` summary commit, OMP first derives the proposed compaction entry and then awaits the staged extension's `session_compaction_precommit` listener before it appends the entry or replaces live session context. If the entry contains a valid bounded `<sheltie-okf>...</sheltie-okf>` marker, the listener writes one private OKF v0.2 handoff: `index.md` and the idempotent `concepts/compaction-<digest>.md` concept with portable, non-file provenance. The listener resolves only after that write completes. A write failure rejects the listener and aborts the compaction attempt; unsafe marker content cancels it without a partial artifact. A missing marker is a successful no-op. Sheltie has no post-compaction persistence fallback. OMP's separate handoff, shake/elide, image-drop, and dead-end recovery rewrites do not emit this event and therefore do not carry this atomic OKF guarantee.

These concepts are durable external knowledge, not live OMP context, logical or run authority, or a mechanism for immediate bounded parent context. They also do not replace the durable inbox or background-node delegation. SQLite remains authoritative, and neither the raw surrounding summary nor raw transcript is copied.

Pattern screening is bounded and best-effort, not exhaustive path, credential, runtime-ID, or secret detection. Empty or oversized markers, wikilinks, traversal/tilde/SSH path signals, credential-like patterns, JWTs, runtime IDs or UUIDs, and long token/hash-like values fail closed without partial output. Processes running as the same Unix user remain outside Sheltie's hard security boundary. Cleanup preserves these private knowledge bundles.

## Quickstart: research team

[`examples/research-team`](examples/research-team/) is a portable four-role example:

```text
coordinator workspace
        |
        v
  team workspace
    /          \
researcher    reviewer
read-only tab read-only tab
```

The coordinator delegates to one isolated team workspace. The team delegates research and review to read-only tabs that share its worktree; their findings return through the durable inbox.

First validate the manifest:

```bash
./dist/sheltie manifest validate --file examples/research-team/sheltie.yaml
```

Then, from a **clean disposable Git checkout**, start the run in default bundled mode. Invoke the `sheltie` executable from the runtime bundle so it resolves its sibling Herdr, OMP, and extension artifacts:

```bash
./sheltie-runtime/sheltie run start \
  --manifest examples/research-team/sheltie.yaml \
  --repo . \
  --state .sheltie-state
```

Existing Herdr sockets remain an explicit external mode:

```bash
./dist/sheltie run start \
  --runtime external \
  --manifest examples/research-team/sheltie.yaml \
  --repo . \
  --herdr-socket "$HERDR_SOCKET" \
  --state .sheltie-state
```

A missing `--state` directory is created with mode `0700`. An existing state directory is accepted only when it is a real, non-symlink directory owned by the effective user and grants no group or other access. Choose a state directory that is not shared with other users.

Useful lifecycle reads are:

```bash
./sheltie-runtime/sheltie run status --state .sheltie-state
./sheltie-runtime/sheltie runtime status --state .sheltie-state
./sheltie-runtime/sheltie observe snapshot --state .sheltie-state
```

Cleanup is operator-sensitive. The default preview exposes only the exact plan digest and aggregate counts. Add `--unsafe-output` only when you are ready to inspect machine-local target paths and runtime identifiers, then apply the reviewed plan with that exact digest:

```bash
./sheltie-runtime/sheltie run cleanup --state .sheltie-state
./sheltie-runtime/sheltie run cleanup --state .sheltie-state --unsafe-output
./sheltie-runtime/sheltie run cleanup --state .sheltie-state --apply --plan-digest <plan-digest>
```

## Completion protocol in the example

`progress` is an ordinary update and **never** establishes completion. A non-root Agent may publish a final `result` only after this ordered sequence:

```text
step complete -> node finish -> message send --kind result
```

The database rejects a result from a node that has not completed. Parents must wait for a completed child's `result` before completing work that depends on it. Workspace children may be merged only after that result; tab children are never merged because they share the parent worktree.

## Cockpit

The [Sheltie Observation Cockpit plugin](plugins/observation-cockpit/herdr-plugin.toml) is an optional, read-only Herdr popup. Register it through Herdr's plugin workflow, configure `SHELTIE_STATE_DIR` to the run's private state directory, and ensure `sheltie` is on `PATH` (or set `SHELTIE_EXECUTABLE`). Open the **Sheltie Cockpit** pane from Herdr.

The Cockpit invokes only `sheltie observe snapshot --state …`; it does not open SQLite itself, call the Herdr API, or mutate the run. Use `r` to refresh, `a` to toggle automatic refresh, and `q` to quit. `SHELTIE_AUTO_REFRESH_MS` may be set to `0` to disable automatic refresh or to a whole number from `500` through `30000` milliseconds.

## CLI overview

| Area | Commands |
| --- | --- |
| Manifest | `manifest validate`, `manifest resolve` |
| Lifecycle | `run start`, `run resume`, `run status`, `run cancel`, `run quiesce`, `run cleanup` |
| Runtime | `runtime status`, `runtime stop`, `runtime attach` |
| Observation | `observe snapshot` |
| Agent protocol | `spawn`, `step claim`, `step complete`, `node finish`, `sync`, `merge`, `message send` |

Agent-protocol commands authenticate the current caller through `HERDR_PANE_ID` (or an explicit `--caller-pane`) and are normally supplied by generated Agent prompts. Use lifecycle and observation commands as the operator-facing interface. `reconcile --unsafe-output` is intentionally not a normal lifecycle surface.

## Safety and security boundaries

- Run state is private by default, and normal lifecycle/observation output is a deliberately constrained surface. Normal lifecycle failures are sanitized. `--unsafe-output` exposes operator diagnostics and exact cleanup targets; do not share that output.
- Sheltie checks live Herdr Agent name, pane, terminal, and per-launch Agent instance identity against persisted state before Agent-facing writes. Manifest capabilities and completion state remain authoritative even when a prompt asks for something else.
- This is a runtime authorization and correctness guard, **not** a sandbox against another process running as the same Unix user with access to the state database, filesystem, or Herdr socket.
- Read-only tab roles must not modify files or create commits. General concurrent read-write tabs have no write lease and are not implemented.
- Cleanup is exact-target and plan-digest bound. Inspect exact targets through an explicit unsafe preview before applying the digest; do not use cleanup as a broad workspace removal command.
- Bundled mode owns only the persisted, named Herdr session for its run. It binds `agent.kind: omp` to the verified absolute OMP artifact through `HERDR_AGENT_OMP_PATH`, keeps the bundle first on `PATH` for subordinate commands, and stops the owned session only after a successful clean result. External sockets are never started or stopped by Sheltie.

For private vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Limitations and roadmap

Current limitations:

- Experimental local PoC only; no production support or availability guarantees.
- Exact compatibility with Herdr 0.8.0/protocol 20 only.
- Inbox waiting is bounded polling, not an event subscription.
- The sender CLI does not yet expose a stable message identity for idempotent retries after uncertain delivery.
- Standard A2A discovery and transport are not implemented.
- The Cockpit is read-only and currently declares Linux support.
- Bundled runtimes are Linux x64 only in this release. A bundle contains both Herdr and OMP; packaging Herdr alone is insufficient because Herdr launches literal `omp …` commands.

Near-term work is expected to focus on stabilizing the manifest and observation contracts, improving delivery semantics, and designing an explicit write-lease model before concurrent read-write tab work is enabled.

## Documentation and contributing

- [Portable research-team example](examples/research-team/)
- [Durable inbox and completion protocol](docs/durable-inbox.md)
- [Runtime bundles and ownership](docs/runtime-bundles.md)
- [Observation Cockpit plugin](plugins/observation-cockpit/herdr-plugin.toml)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Apache-2.0 license](LICENSE)

Contributions are welcome under the guidance in [CONTRIBUTING.md](CONTRIBUTING.md). Sheltie is licensed under [Apache-2.0](LICENSE).
