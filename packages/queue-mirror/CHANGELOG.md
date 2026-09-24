# @titan-design/queue-mirror

## 0.3.1

### Patch Changes

- Updated dependencies [9bc4dce]
  - @titan-design/matrix-bus@0.2.0

## 0.3.0

### Minor Changes

- ee3806a: Add a `resync` SourceEvent that re-runs open() reconciliation and commits its cursor, and edit a phone item `refused: <detail>` when the source rejects a verdict, leaving it open. Document that `QueueSource.tail` must connect eagerly.

## 0.2.0

### Minor Changes

- 8fe044d: `runMirror` and `createMirror` project a `QueueSource` into the `#queue` room: each item is posted once under a deterministic txnId, the source cursor and /sync token are committed only after handling, owner reactions and replies to open approvable items resolve through the source, redacted or truncated items refuse phone verdicts, and every close (source, phone verdict or expiry) edits the item with `m.replace`. The `/hitl` subpath adds `hitlQueueSource`, which mirrors a hitl `GateStore`'s pending gates as approvals or questions and resolves or cancels them from the owner's verdict.
- e3ce048: Adds `@titan-design/queue-mirror/sqlite`: `SqliteMirrorState`, a durable `MirrorState` over `@titan-design/store-sqlite` whose `commit` runs in one transaction, plus `mirrorMigration` for products that own their own migration list.

## 0.1.0

### Minor Changes

- ed825dd: New package (TP-316): the `QueueSource` and `MirrorState` ports, `MemoryQueueSource` and `MemoryMirrorState` for tests, `redactPreview` (section 10 decision 3: bearer and basic auth, `token=`, `key=`, `password=`, and 32-plus hex or base64 runs, except a run of exactly 40 hex characters, which is a git commit SHA), and `toItemInput`, which redacts an item and then fits its encoded content under 60,000 bytes, marking it redacted or truncated.

### Patch Changes

- Updated dependencies [52265d6]
  - @titan-design/matrix-bus@0.1.0
