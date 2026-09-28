# @titan-design/queue-mirror

Projects a local queue of human-actionable items (agent approvals, endorsements, questions,
notices) into a Matrix `#queue` room, and folds the owner's reactions and replies back into
verdicts on that queue. Each item is posted once, secrets in previews are redacted, and every
close edits the item with `m.replace`.

- `runMirror(source, bus, state, options)`: the supervised loop.
- `QueueSource` and `MirrorState` ports, with `MemoryQueueSource` and `MemoryMirrorState`.
- `@titan-design/queue-mirror/hitl`: `hitlQueueSource(store, options)` over a hitl `GateStore`.
- `@titan-design/queue-mirror/sqlite`: `SqliteMirrorState`, the durable `MirrorState`, and
  `mirrorMigration(version, prefix)` for a product's own migration list.

`runMirror` calls `source.tail()` before `reconcile()`, so a `QueueSource.tail` must connect
eagerly: the connection must exist when `tail()` returns, not at the first `next()`. A lazy
`async function*` misses items opened during reconcile. A source that cannot replay a gap
yields `{type: "resync", cursor}`, and the mirror reconciles against `open()` and commits
the cursor. A `rejected` verdict edits the item `refused: <detail>` and leaves it open.

Tier 2 of the titan-platform DAG. Depends on `@titan-design/matrix-bus`,
`@titan-design/hitl` and `@titan-design/store-sqlite`. The root entry has no `node:` import.

Reference: [site/reference/queue-mirror.md](../../site/reference/queue-mirror.md).
