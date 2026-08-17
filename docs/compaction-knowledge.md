# Automatic compaction knowledge

`spec.knowledge.compaction` opts eligible OMP roles into private, durable OKF handoffs at automatic `context-full` compaction boundaries:

```yaml
knowledge:
  compaction:
    format: okf-v0.2
    roles: [coordinator, team]
    thresholdPercent: 70
```

The selected roles receive a private OMP configuration overlay. Sheltie stages its OKF extension and passes that private copy only to selected OMP processes. A role without this manifest selection starts without the extension and therefore registers no compaction listener.

## Awaited lifecycle

For each normal automatic `context-full` summary commit, OMP computes the proposed compaction entry and emits the awaited `session_compaction_precommit` extension event before it appends the entry or replaces the session's live message context. The staged extension registers one async listener for that event while automatic context-full compaction is active. Separate handoff, shake/elide, image-drop, and dead-end recovery rewrites do not emit this event and are outside the atomic OKF lifecycle.

The listener reads only the bounded `<sheltie-okf>...</sheltie-okf>` marker from the proposed entry summary. With a valid marker, it creates exactly one content-addressed OKF handoff:

- `index.md`, a byte-stable bundle index;
- `concepts/compaction-<sha256>.md`, an immutable private draft concept.

The listener resolves only after the private files have been durably published. A publication error rejects the listener, so OMP aborts that automatic compaction attempt before changing the live context. Unsafe marker content returns a cancellation result without publishing a partial artifact. A missing marker is an intentional no-op. Sheltie does not use `session_compact` as a persistence fallback, because that event is after context replacement and cannot establish this happens-before guarantee.

Manual compaction is outside this lifecycle; only the automatic `context-full` state activates the listener's writer.

## Recovery-path limitation

The durable OKF writer runs only for normal automatic `context-full` compaction. OMP's handoff, shake/elide, image-drop, and dead-end recovery rewrites do not emit `session_compaction_precommit`, so Sheltie intentionally creates no recovery-path compaction handoff. There is no post-rewrite persistence fallback because it could not provide the required before-context-replacement guarantee.

## Knowledge boundary

An OKF handoff is durable external knowledge. It is not:

- a replacement for OMP's live session context;
- a guarantee of immediate or bounded parent context;
- SQLite, run, or logical authority;
- a replacement for the durable inbox or background-node delegation.

The surrounding generated summary and raw transcript are not copied. Concepts have portable non-file provenance and remain private, unverified drafts. SQLite remains authoritative for Sheltie run state.

## Safety

Before publishing, the listener rejects empty or oversized markers and screens for wikilinks, paths, credentials, JWTs, runtime identifiers, UUIDs, and long opaque values. This screening is bounded and best-effort; it is not a general secret-scanning guarantee. The same-Unix-user process boundary remains outside Sheltie's hard security boundary.
