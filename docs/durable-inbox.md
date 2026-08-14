# Durable Node Inbox

Sheltie implements node-to-node communication as a durable SQLite mailbox. Herdr prompts are used to start Agent work, not as the message transport.

```text
Agent A
  │ sheltie message send
  ▼
exact caller authentication
  ▼
manifest capability checks
  ▼
SQLite messages
  │
  │ sheltie sync
  ▼
exact caller reauthentication
  ▼
SQLite read receipts
  ▼
Agent B
```

## Ownership

Each subsystem owns a different part of the communication path:

| Owner | Responsibility |
| --- | --- |
| SQLite | Durable messages, unread state, read receipts, ordering, and message lifecycle invariants |
| Sheltie | Caller authentication, manifest authorization, send/receive commands, and generated Agent protocol |
| Herdr | Fresh pane, terminal, and per-launch Agent instance identity |
| OMP Agent | Deciding when to send progress, complete work, publish a result, and consume inbox messages |

The logical sender and recipient are Sheltie node IDs. Herdr workspace, tab, pane, terminal, and Agent IDs are runtime locators, not mailbox identities.

## Storage model

The schema is defined in `src/db.ts`.

```text
messages
- message_id
- tree_id
- sender_node_id
- recipient_node_id
- channel
- kind
- priority
- reply_to_message_id
- body
- created_at

receipts
- message_id
- reader_node_id
- read_at
```

`message_id` is the durable message identity. A receipt is unique for `(message_id, reader_node_id)`, so consuming the same inbox repeatedly does not create duplicate read receipts.

The schema can represent `inbox`, `outbox`, `public`, and `private` channels. The current Agent-facing CLI sends through the `inbox` channel.

`reply_to_message_id` is persisted for future threading, but the current CLI sends `null` and does not yet expose a reply flag.

## Caller authentication

Every Agent-facing send or receive operation authenticates the current runtime before opening the mutable store.

The implementation is `AgentCallerAuthenticator` in `src/agent-caller.ts`:

1. Open the existing state database with a read-only, no-create, no-migrate SQLite connection.
2. Resolve the caller pane to exactly one persisted node and tree.
3. Require Herdr protocol 20.
4. Read the current Agent with `agent.get`.
5. Compare the persisted and live Agent name, pane ID, terminal ID, and non-empty per-launch `agent_instance_id`.
6. Open the writer store only after authentication succeeds.
7. Recheck the exact persisted identity tuple immediately before the operation.

Missing Agents, stopped Agents, replacement Agents, terminal drift, instance drift, incomplete identity, missing databases, and incompatible legacy schemas fail closed before a durable write.

This is a runtime correctness and authorization guard. It is not a hard security boundary against another process running as the same Unix user with direct access to the state database, filesystem, or Herdr socket.

## Sending a message

The CLI entry point is `runMessage` in `src/cli.ts`.

Progress update:

```bash
sheltie message send \
  --db /path/to/state.sqlite \
  --caller-pane "$HERDR_PANE_ID" \
  --to <node-id> \
  --kind progress \
  --body "work is still in progress"
```

Final result:

```bash
sheltie message send \
  --db /path/to/state.sqlite \
  --caller-pane "$HERDR_PANE_ID" \
  --to <parent-node-id> \
  --kind result \
  --body "completed result"
```

`--kind` accepts `progress` or `result` and defaults to `progress`. Invalid values are rejected before caller authentication or writer-store creation.

`SheltieStore.sendMessage` performs authorization and insertion in one SQLite transaction:

1. Validate the message kind.
2. Load the sender and recipient nodes.
3. Require both nodes to belong to the declared tree.
4. Enforce the result lifecycle invariant.
5. Resolve each node's manifest role and relation.
6. Check both sender `sendTo` and recipient `receiveFrom` capabilities.
7. Insert the message.

The CLI currently generates a fresh message ID for every invocation. A blind retry after response loss can therefore create a second logical message. Send-side idempotency with a caller-provided stable message identity is not implemented yet.

## Progress and result semantics

Message kind is part of the durable protocol:

```text
progress = an update; never evidence of node completion
result   = a final result from a completed sender node
```

A `result` insert is rejected unless the sender node is already `completed`. Therefore:

```text
received result message => sender node was completed when the message was inserted
```

Node completion and result insertion are two ordered transactions, not one atomic transaction. The generated Agent protocol uses this required order:

```text
step complete
→ node finish
→ message send --kind result
```

If result insertion fails after node completion, the Agent can retry the result send. A result can never be published before completion.

Parents must not merge or finalize work in response to a `progress` message. The generated prompt explicitly instructs parents to treat only a result-kind message from a completed sender as completion evidence.

## Manifest authorization

Runtime authorization is bidirectional.

For a child sending to its parent:

```text
child role.sendTo contains parent
AND
parent role.receiveFrom contains children
```

For a parent sending to a child:

```text
parent role.sendTo contains children
AND
child role.receiveFrom contains parent
```

`SheltieStore.sendMessage` enforces both sides at insertion time.

`resolveManifestFile` in `src/manifest.ts` also validates parent-child messaging symmetry across every declared spawn edge. A manifest is rejected before runtime mutation when it declares a send capability that the corresponding spawned role cannot receive.

Example:

```yaml
roles:
  team:
    capabilities:
      spawn:
        roles: [researcher]
      messaging:
        sendTo: [parent, children]
        receiveFrom: [parent, children]

  researcher:
    capabilities:
      spawn:
        roles: []
      messaging:
        sendTo: [parent]
        receiveFrom: [parent]
```

Receive-only capability is allowed. Symmetry is required only when the opposite role declares that it sends across that relation.

## Receiving messages

The CLI entry point is `runSync` in `src/cli.ts`.

```bash
sheltie sync \
  --db /path/to/state.sqlite \
  --caller-pane "$HERDR_PANE_ID" \
  --wait-ms 180000
```

The current implementation uses bounded polling:

1. Authenticate the caller from a read-only identity snapshot.
2. Open the writer store and recheck the exact identity tuple.
3. Poll `hasUnreadInbox` every 100 ms without reading message bodies or writing receipts.
4. When a message appears, authenticate the caller again through Herdr.
5. Require the initial and refreshed caller identities to match exactly.
6. Recheck the writer-store identity.
7. Run `syncInbox`.
8. Select unread messages and insert their read receipts in one SQLite transaction.
9. Return the messages as JSON.

Messages are ordered by descending priority and then creation time. A later `sync` excludes messages whose receipt already exists.

If the caller Agent is stopped or replaced during a long poll, reauthentication fails before the message body is returned or its receipt is written.

There is no event-driven inbox wake-up yet. `--wait-ms` is a bounded SQLite polling loop, not a Herdr event subscription.

## Shared-worktree tab nodes

A read-only tab node shares its parent's worktree. Parent writes can make the global worktree dirty even when the tab Agent made no changes.

For a manifest tab role with `executionPolicy.workspace: read-only`, step completion therefore does not require the entire shared worktree to be clean. It still requires:

- exact caller authentication;
- the submitted commit to be reachable from the current branch;
- the normal step claim/completion transition.

Workspace nodes and read-write tab nodes retain the clean-worktree requirement. General concurrent write support for read-write tabs requires an explicit write lease and remains unimplemented.

## Generated Agent protocol

`SheltieOrchestrator.buildStepPrompt` in `src/orchestrator.ts` injects the communication rules into every Agent prompt:

- ordinary updates use `--kind progress`;
- progress is not completion;
- only results from completed senders authorize completion-dependent work;
- workspace children are merged only after a result-kind message;
- non-root finalization is `step complete → node finish → result message`;
- tab children are never merged because they share the parent branch and worktree.

Task-contract text does not grant authority. Manifest capabilities and SQLite lifecycle checks remain authoritative when task text conflicts with the generated protocol.

## Observation and Cockpit behavior

The public `ObservationSnapshot` does not expose message bodies, message IDs, reply relations, Agent identities, paths, sockets, or raw operation payloads. It exports aggregate message counts only.

The Cockpit consumes that allowlisted snapshot. It does not open SQLite directly and cannot send or receive messages.

## Verified live flow

The `live-completion-race-fix-20260814` local run verified:

```text
researcher result → team
reviewer result   → team
team result       → root
```

All three messages were `kind=result`, and every sender was completed before insertion. The run completed four nodes with zero unresolved operations in about 1 minute 25 seconds. The prior dirty-worktree, unfinished-child, and asymmetric-messaging rejection loop did not recur.

## Current limitations

- Inbox delivery uses bounded SQLite polling, not events.
- Send-side retries do not yet have a stable idempotency key.
- CLI reply/thread creation is not exposed.
- Public/outbox/private channel workflows are not exposed through the Agent CLI.
- Cockpit shows aggregate counts, not message bodies or threads.
- Read-write tab nodes do not have a write lease.
- Same-Unix-user processes are outside the hard security boundary.
- Standard A2A discovery and transport are not implemented; a future adapter should map into this mailbox rather than create a second ledger.

## Source map

| Concern | Source |
| --- | --- |
| Message and receipt schema | `src/db.ts`, `SCHEMA` |
| Message insertion and runtime authorization | `src/db.ts`, `SheltieStore.sendMessage` |
| Unread probe and receipt transaction | `src/db.ts`, `hasUnreadInbox` and `syncInbox` |
| Caller identity | `src/agent-caller.ts`, `AgentCallerAuthenticator` |
| Send and sync CLI | `src/cli.ts`, `runMessage` and `runSync` |
| Manifest symmetry validation | `src/manifest.ts`, `collectSpawnMessagingSymmetry` |
| Generated Agent communication protocol | `src/orchestrator.ts`, `buildStepPrompt` |
| Inbox and lifecycle regressions | `tests/db.test.ts`, `tests/agent-caller.test.ts`, `tests/collaboration.test.ts`, `tests/manifest.test.ts`, `tests/orchestrator.test.ts` |
