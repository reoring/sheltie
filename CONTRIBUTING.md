# Contributing to Sheltie

Thanks for improving Sheltie. The project is an experimental local PoC, so a contribution should make one observable contract clearer or safer without presenting the project as production-ready.

## Development setup

Sheltie uses Bun 1.3.13. Install Bun directly, or enter the pinned optional Devbox environment:

```bash
devbox shell
bun install
```

Use a clean Git checkout. The runnable CLI is TypeScript during development; `bun run build` produces `dist/sheltie` for the compiled local executable.

## Checks

Choose the smallest deterministic check that covers the change, then run broader checks when the affected contract warrants them.

```bash
# Focused: replace the file with the contract you changed.
bun test tests/manifest.test.ts

# Full test suite.
bun test

# Static type check.
bun run typecheck

# Local executable build.
bun run build
```

For example, changes to the Cockpit should use its focused coverage, and changes to manifest rules should use manifest and collaboration coverage. Documentation-only changes still need careful source review for factual accuracy, but do not need unrelated checks merely because they edit prose.

## Change discipline

- Start from the owning source and current tests; preserve the existing manifest, lifecycle, and output contracts.
- Prefer a root-cause fix to a special case or compatibility shim. Keep unrelated refactors out of the same change.
- Update public documentation and portable examples when user-visible behavior, prerequisites, security boundaries, or the manifest schema changes.
- Keep examples portable: use repository-relative prompt files, placeholders, and generic environment variables. Never add a machine-local path, live identifier, credential, socket path, state data, or private evidence to the repository.
- Preserve the exact Herdr compatibility gate: public `reoring/herdr` revision `dda3fb5a99752948c87214d79e8b218e3a5b4078`, Herdr 0.8.0, protocol 20.
- Treat `progress` as an update, never as completion. A non-root final result follows `step complete -> node finish -> result`.
- Preserve normal-output safety. Product-facing output and Cockpit errors must not expose state paths, sockets, prompts, Agent identities, raw operation payloads, or message bodies. Normal executable lifecycle failures stay sanitized unless the operator explicitly requests `--unsafe-output`.

## Security boundaries

Sheltie requires a private state directory. It creates a missing final state directory as `0700` and rejects an existing directory that is a symlink, belongs to another UID, or permits group or other access. Do not weaken this behavior or add alternate storage paths without a clear security design.

Caller authentication and manifest authorization protect Sheltie's runtime protocol. They are not a hard boundary against another process running as the same Unix user with access to the state database, filesystem, or Herdr socket. Do not claim otherwise.

Cleanup is an operator-sensitive exact-target workflow: obtain the safe digest preview, inspect exact targets only with explicit `--unsafe-output`, and apply only with that digest. Changes affecting cleanup targets, Agent authorization, state ownership, or public output require focused review and negative-path coverage.

Report a suspected vulnerability privately as described in [SECURITY.md](SECURITY.md), not in a public issue or pull request.

## Pull requests

A good pull request:

1. Explains the user-visible contract or bug being changed and why.
2. Includes focused verification evidence appropriate to the changed behavior.
3. Includes a regression test when a deterministic observable contract is newly added or repaired.
4. Updates affected public docs, examples, or CLI usage where necessary.
5. Keeps secrets, local artifacts, generated state, and unrelated formatting churn out of the diff.

By submitting a contribution, you agree that it is offered under the repository's [Apache-2.0 license](LICENSE).
