# queue-mirror

**Tier 2.** Depends on `@titan-design/matrix-bus`; the `/hitl` subpath also uses
`@titan-design/hitl`, and the `/sqlite` subpath uses `@titan-design/store-sqlite`.

```sh
npm install @titan-design/queue-mirror
```

## The problem it solves

A local process holds pending work that only a human can settle: a tool approval, an
endorsement, a question. The owner wants to settle it from a phone, in a stock Matrix
client, without the terminal. matrix-bus sends events and folds one reaction into a
verdict. It does not decide what to post, when to post it again, or what to do after a
crash. queue-mirror adds that projection loop. It posts each pending item into `#queue`
exactly once and folds the owner's reactions and replies back into the source. It edits
each item when it closes, strips secrets from previews, and persists enough state that a
restart neither loses nor duplicates anything.

## When to reach for it

- A queue of human decisions in a product (agent-chat approvals, a hitl gate store in a
  daemon) that should also be answerable from Matrix.
- A test that needs a realistic mirror over an in-memory queue: `MemoryQueueSource`,
  `MemoryMirrorState` and `createMirror`'s step methods.

Reach for `matrix-bus` directly for one-off sends, room bootstrap or appservice
registration, and for `hitl` alone when nobody needs to answer away from the terminal.

## Example

Verified against 0.2.0 and Tuwunel 1.9.2.

```ts
import { AppserviceClient } from "@titan-design/matrix-bus";
import { MemoryMirrorState, runMirror } from "@titan-design/queue-mirror";
import { hitlQueueSource } from "@titan-design/queue-mirror/hitl";
import { MemoryGateStore } from "@titan-design/hitl";

const gates = new MemoryGateStore();
const bus = new AppserviceClient({ baseUrl, asToken, sender: "@ac-edge1:chat.example.org" });
const controller = new AbortController();

void runMirror(hitlQueueSource(gates, { machine: "edge1", session: "ff-daemon" }), bus, new MemoryMirrorState(), {
  ownerUserId: "@owner:chat.example.org",
  roomId,
  signal: controller.signal,
});

gates.create({ prompt: "draft Bijan Robinson?" }); // appears in #queue; the owner's ✅ resolves it {approved: true}
```

## The pieces

**Ports.** A `QueueSource` has `kinds`, `open()`, `tail(cursor, signal)` and
`resolve(id, verdict)`. `tail` yields `opened`, `closed` and `resync` events, each with an
opaque cursor. A source yields `{type: "resync", cursor}` when it can no longer replay what
it missed, for example after a gap too large for its change feed. The mirror then runs the
same reconciliation as at startup against `open()` and commits the cursor. `resolve`
returns `{ok: true}`, `{ok: false, reason: "closed"}` (already settled) or
`{ok: false, reason: "rejected", detail?}` (the source refused the verdict). A rejected
item stays open and approvable, and the mirror edits its status to `refused: <detail>`.
A `MirrorState` is synchronous. It maps source ids to posted event ids, holds the source
cursor, the /sync token and the applied resolution event ids, and applies each
`commit(change)` atomically.

**The loop.** `runMirror(source, bus, state, options)` runs three supervised loops until
`options.signal` aborts. Each restarts after a throw with doubling backoff (1 s to 60 s)
and resets after progress.

- *Source.* Opens `tail(state.sourceCursor())` before it reconciles, so an item opened
  during reconcile arrives through the tail. That only works if `tail` connects eagerly
  (see Gotchas). Then it reconciles. It posts each `open()`
  item the state does not know and edits items that vanished while the mirror was down.
  Then it applies each tail event.
- *Sync.* Reads `/sync` filtered to the room (`syncFilter`). For each batch it folds every
  owner reaction, reply or `io.titan.resolution` that targets an open approvable item,
  and only then commits `since`.
- *Sweep.* Every `sweepIntervalMs` it closes items past `expiresAt`, or past
  `at + approvalTtlMs` for approvals, and edits them "expired".

`createMirror` exposes the same steps (`reconcile`, `applySourceEvent`,
`applySyncBatch`, `sweepExpired`) for deterministic tests.

**Posting and edits.** An item is sent with txnId `qm-<sourceId>` and its close edit with
`qm-edit-<sourceId>`. A `refused` status edit uses `qm-reject-<sourceId>-<resolutionEventId>`,
so it never takes the txnId the final close edit needs. The homeserver dedupes a replay after a crash between send and
commit. The edit is an `m.replace` with a short body (headline plus a status line) and
the original `io.titan.item` record in `m.new_content`.

**Redaction** (design section 10, decision 3). `toItemInput` runs `redactPreview` over
`input_preview` for approvals and over the text of endorsements. It masks `Bearer` and
`Basic` credentials, `…token`, `…key` and `…password` values (`=` or `:`, JSON keys
included), hex runs of 32 or more characters, and base64 runs of 32 or more characters
that mix digits and both cases and have no plain-word path segment. A run of exactly 40
hex characters is a git commit SHA and stays visible. A redacted item is posted with
`redacted: true` and cannot be approved from the phone.

**Size.** `fitItem` halves `input_preview` and `text` on code-point boundaries until the
encoded content is at most 60,000 bytes. It then marks the item `truncated`, which also
makes it unapprovable. Redaction runs first.

**`/hitl`.** `hitlQueueSource(store, options)` turns pending gates into items: a gate
with a schema becomes a `question`, one without becomes an `approval_request`. `tail`
polls `listPending()` every `pollMs` (hitl has no change feed). allow and approve resolve
`{approved: true}`, an answer resolves its text, and deny and dismiss cancel with
"denied from Matrix". Override this mapping with `toPayload`. hitl errors are matched by
`name`, not `instanceof`.

**`/sqlite`.** `new SqliteMirrorState(db, { tablePrefix?, migrate? })` is the durable
`MirrorState` over [`store-sqlite`](/reference/store-sqlite). It keeps three tables,
`<prefix>_item`, `<prefix>_applied` and `<prefix>_cursor` (prefix
`DEFAULT_MIRROR_TABLE_PREFIX`, `queue_mirror`), and runs every `commit` in one
transaction, so a failure partway leaves no partial rows. By default the constructor runs
`mirrorMigration(1, prefix)`. A product that owns its migration list passes
`migrate: false` and puts `mirrorMigration(version, prefix)` in that list instead.
`mirrorTableDdl(prefix)` is the raw DDL.

## What it deliberately does not do

- It does not redact `question`, `notice` or `message` text. Decision 3 scopes redaction
  to previews and endorsements.
- It does not keep durable state on its own. `MemoryMirrorState` is lost with the
  process; the `/sqlite` subpath is the durable one.
- It does not backfill a limited `/sync` timeline yet. matrix-bus now reports `limited`
  and `prev_batch` on each `SyncBatch`, but the mirror ignores them, so after a long sleep
  reactions older than the timeline limit are not folded (design R13).
- It does not create the room or register the appservice. That is `matrix-bus`.

## Gotchas

- `QueueSource.tail` must connect eagerly. `runMirror` calls `tail()` before
  `reconcile()`, so the connection (or the "from now" position) must exist when `tail()`
  returns. A plain `async function*` runs nothing until the first `next()`, which comes
  after reconcile, and items opened during reconcile are then missed. Open the connection
  in `tail()` and return an iterable over it, as `MemoryQueueSource.tail` does.
- `since` is persisted after a batch is handled, not before as the matrix-bus `syncLoop`
  docstring suggests. A crash replays the batch, and `hasApplied` drops what was
  already done.
- `approvalTtlMs` must be the same value the source uses. Otherwise the phone says
  "expired" while the terminal still accepts. The source's own `closed/expired` event
  stays authoritative.
- A schema'd hitl gate that expects an object rejects a bare reply string. The adapter
  returns `rejected` and the item stays open for the terminal; pass `toPayload` to shape
  answers.
- `PostedItem.record` holds the posted record, preview included. A state store must
  persist it, because edits after a restart need it.

## Integration test

`src/integration.test.ts` is skipped unless `MATRIX_BASE_URL` is set. It reads the same
variables as matrix-bus's: `MATRIX_SERVER_NAME`, `MATRIX_OWNER_PASSWORD`,
`MATRIX_EDGE_AS_TOKEN`, and optionally `MATRIX_OWNER_USER` (default `owner`) and
`MATRIX_EDGE_MACHINE` (default `edge1`). It creates a fresh `#queue-qm-<ts>` room and
checks txnId dedupe across client instances (R1) and an `m.replace` from the appservice
sender (R4). It resolves an item on the owner's ✅, edits a locally closed item, refuses
a redacted item, and answers questions from replies with and without a legacy fallback
(R6). It then restarts the mirror and checks that nothing is posted twice.

## Where it came from

New in TP-316, the stage 1 human queue in Matrix (design:
`plan-stage1-matrix-human-queue-2026-09-23.md`, sections 4, 5, 10 and 12). The agent-chat
mirror (CC-145) is its first consumer.
