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
- A local Herdr runtime at the compatibility level above, with a reachable Unix socket. Supply its socket path to `--herdr-socket`.
- An OMP Agent runtime that Herdr can start for manifest roles whose `agent.kind` is `omp`.
- A Unix-like local environment. The optional Cockpit plugin currently declares Linux support.

[Devbox](https://www.jetify.com/devbox) is optional and provides the pinned development environment.

## Install and build

Clone this repository and build the local executable; Sheltie is deliberately not presented as an npm package.

```bash
git clone https://github.com/reoring/sheltie.git
cd sheltie
bun install
bun run build
```

The build writes the executable to `dist/sheltie` and the sibling bundled automatic-compaction extension to `dist/sheltie-okf-compaction.js`.

## Automatic compaction knowledge

A manifest may opt a sorted, unique list of root or parent-capable `agent.kind: omp` roles into private automatic-compaction preservation:

```yaml
knowledge:
  compaction:
    format: okf-v0.2
    roles: [coordinator, team]
    thresholdPercent: 70
```

Selected roles receive an owner-private `context-full` overlay with `remoteEnabled: false`, the manifest threshold, `thresholdTokens: -1`, and `autoContinue: true`; OMP therefore uses local context-full summarization and honors `session.compacting` marker context. The configured automatic-compaction extension is staged as a private copy before OMP starts, and only that staged extension is passed to OMP.

While an automatic compaction is active, the staged extension asks for a bounded `<sheltie-okf>...</sheltie-okf>` marker and extracts only that marker. For each selected node it writes a private OKF v0.2 bundle: `index.md` and an idempotent `concepts/compaction-<digest>.md` concept with portable, non-file provenance. Concepts are private, unverified drafts rather than logical or run authority; SQLite remains authoritative, and the raw surrounding summary or raw transcript is never copied.

Pattern screening is bounded and best-effort, not exhaustive path, credential, runtime-ID, or secret detection. Empty or oversized markers, wikilinks, traversal/tilde/SSH path signals, credential-like patterns, JWTs, runtime IDs or UUIDs, and long token/hash-like values fail closed without partial output. Processes running as the same Unix user remain outside Sheltie's hard security boundary. Knowledge or extension write failures are logged without aborting compaction, so artifact emission may be skipped. Cleanup preserves these private knowledge bundles.

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

Then, from a **clean disposable Git checkout**, start the run with the socket path for your compatible local Herdr runtime:

```bash
./dist/sheltie run start \
  --manifest examples/research-team/sheltie.yaml \
  --repo . \
  --herdr-socket "$HERDR_SOCKET" \
  --state .sheltie-state
```

A missing `--state` directory is created with mode `0700`. An existing state directory is accepted only when it is a real, non-symlink directory owned by the effective user and grants no group or other access. Choose a state directory that is not shared with other users.

Useful lifecycle reads are:

```bash
./dist/sheltie run status --state .sheltie-state
./dist/sheltie observe snapshot --state .sheltie-state
```

Cleanup is operator-sensitive. The default preview exposes only the exact plan digest and aggregate counts. Add `--unsafe-output` only when you are ready to inspect machine-local target paths and runtime identifiers, then apply the reviewed plan with that exact digest:

```bash
./dist/sheltie run cleanup --state .sheltie-state
./dist/sheltie run cleanup --state .sheltie-state --unsafe-output
./dist/sheltie run cleanup --state .sheltie-state --apply --plan-digest <plan-digest>
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
| Observation | `observe snapshot` |
| Agent protocol | `spawn`, `step claim`, `step complete`, `node finish`, `sync`, `merge`, `message send` |

Agent-protocol commands authenticate the current caller through `HERDR_PANE_ID` (or an explicit `--caller-pane`) and are normally supplied by generated Agent prompts. Use lifecycle and observation commands as the operator-facing interface. `reconcile --unsafe-output` is intentionally not a normal lifecycle surface.

## Safety and security boundaries

- Run state is private by default, and normal lifecycle/observation output is a deliberately constrained surface. Normal lifecycle failures are sanitized. `--unsafe-output` exposes operator diagnostics and exact cleanup targets; do not share that output.
- Sheltie checks live Herdr Agent name, pane, terminal, and per-launch Agent instance identity against persisted state before Agent-facing writes. Manifest capabilities and completion state remain authoritative even when a prompt asks for something else.
- This is a runtime authorization and correctness guard, **not** a sandbox against another process running as the same Unix user with access to the state database, filesystem, or Herdr socket.
- Read-only tab roles must not modify files or create commits. General concurrent read-write tabs have no write lease and are not implemented.
- Cleanup is exact-target and plan-digest bound. Inspect exact targets through an explicit unsafe preview before applying the digest; do not use cleanup as a broad workspace removal command.

For private vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Limitations and roadmap

Current limitations:

- Experimental local PoC only; no production support or availability guarantees.
- Exact compatibility with Herdr 0.8.0/protocol 20 only.
- Inbox waiting is bounded polling, not an event subscription.
- The sender CLI does not yet expose a stable message identity for idempotent retries after uncertain delivery.
- Standard A2A discovery and transport are not implemented.
- The Cockpit is read-only and currently declares Linux support.

Near-term work is expected to focus on stabilizing the manifest and observation contracts, improving delivery semantics, and designing an explicit write-lease model before concurrent read-write tab work is enabled.

## Documentation and contributing

- [Portable research-team example](examples/research-team/)
- [Durable inbox and completion protocol](docs/durable-inbox.md)
- [Observation Cockpit plugin](plugins/observation-cockpit/herdr-plugin.toml)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Apache-2.0 license](LICENSE)

Contributions are welcome under the guidance in [CONTRIBUTING.md](CONTRIBUTING.md). Sheltie is licensed under [Apache-2.0](LICENSE).
