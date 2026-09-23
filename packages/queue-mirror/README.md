# @titan-design/queue-mirror

Projects a local queue of human-actionable items (agent approvals, endorsements, questions,
notices) into a Matrix `#queue` room, and folds the owner's reactions and replies back into
verdicts on that queue. Each item is posted once, secrets in previews are redacted, and every
close edits the item with `m.replace`.

- `runMirror(source, bus, state, options)`: the supervised loop.
- `QueueSource` and `MirrorState` ports, with `MemoryQueueSource` and `MemoryMirrorState`.
- `@titan-design/queue-mirror/hitl`: `hitlQueueSource(store, options)` over a hitl `GateStore`.

Tier 2 of the titan-platform DAG. Depends on `@titan-design/matrix-bus` and
`@titan-design/hitl`. The root entry has no `node:` import.

Reference: [site/reference/queue-mirror.md](../../site/reference/queue-mirror.md).
