# Sheltie

Sheltie coordinates a manifest-declared team of OMP Agents in Herdr workspaces, using durable and capability-checked SQLite messaging rather than prompt text as its message transport.

> **Experimental local PoC.** Sheltie is for local, disposable research and development workflows. It is not production-ready, is not a hosted service, and must not be used as a hard security boundary.

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

The build writes the executable to `dist/sheltie`.

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
