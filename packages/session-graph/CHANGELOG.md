# @titan-design/session-graph

## 0.7.0

### Minor Changes

- 0877916: Add migration 5, "origin, episodes, prices": the `session_origin`, `session_external_event`, `episode` and `price` tables, plus the `request_dedup`, `request_cost` and `context_contribution` views. Every cost query should read `request_dedup`, never `request`, so fan-out copies of one request count once.

  Add the `OriginResolver` seam. Pass `resolveOrigins` to `refreshCorpus` and, once per pass, it is asked about every session with no origin row or one older than the session's `ended_at`. Each resolved origin with a parent becomes a `spawned` edge and a `subagent` row (`agent:<originSystem>:<agentId>`), so existing subagent queries cover launcher-spawned workers. A resolver that throws is reported in `RefreshSummary.origins` and never fails the pass. `resetIndex` clears the origin tables and episodes; `purgeTranscript` drops a rewritten session's episodes.

## 0.6.0

### Minor Changes

- 1e41479: Add the audit rollup and recompute `session_model_usage` from the `request` table (TP-266).

  `rollupSessions` now fills the rollup-owned audit columns for touched sessions, in the same transaction and batch loop as the turn rollup: `request.seq_in_session`, `gap_ms`, `ctx_delta` and the `wake_*` columns, `inbound.queued_ms`, `compaction.mid_loop` and `turn.wake_cause`.

  **Behaviour change: usage totals roughly halve.** `applyDelta` no longer accumulates usage line by line. One API response is written as several assistant lines, and each line used to add its usage again, so token counts and `request_count` were inflated. `session_model_usage` is now recomputed from `request`, which holds one row per request ID. Sessions with no request rows, such as those whose transcripts are gone, keep their old rows until they are re-indexed.

- 79a855d: Add migration 4, "audit tables", and write session-read's audit events into it (TP-265).

  The migration creates `request`, `tool_call`, `inbound`, `context_block`, `compaction`, `queue_op`, `session_signal`, `cost_state_observation` and `transcript_facet`, and adds `session.account`, `turn.wake_cause`, `task.estimate`, `pr.review_rounds`, `pr.closed_at` and `pr.outcome_checked_at`. Each `ADD COLUMN` is guarded, so the migration also succeeds on a database that already has some of those columns.

  `applyDelta` now writes the audit rows in the same transaction as everything else. It stores one `request` row per `(transcript_id, request_id)` with the smallest byte offset and timestamp and the largest value of each token column. It takes an optional fourth argument, `{ account }`, and `indexTranscript` passes the discovered transcript's account into `session.account`. `purgeTranscript` and `resetIndex` clear the new tables. `AUDIT_TABLES`, `FACET_TABLE` and `AUDIT_MIGRATION_NAME` are exported.

  `session_signal`'s primary key is `(transcript_id, byte_offset, block_index, signal)`: a single tool block can emit more than one signal (for example a Bash block that both commits and pushes), and the signal name is what disambiguates those rows.

- 1a47098: Backfill the audit facet of transcripts indexed before migration 4 (TP-267).

  `backfillFacets(graph, transcripts, { limit, version })` re-reads each stale transcript from byte 0 to its watermark and replaces its rows in the eight audit tables, newest `file_mtime` first, 40 per call by default. It never writes the legacy tables, and it skips `missing` and `quarantined` transcripts. `refreshCorpus` calls it after indexing, rolls up the sessions it touched, and reports `facetsBackfilled` and `facetBacklog`; its new `facetLimit` option sets the per-pass cap. A read from byte 0 records the facet at the current `EXTRACT_VERSION`, while an append to a transcript whose facet is stale leaves the facet for the backfill.

  `applyAudit`, `AUDIT_DDL`, `AUDIT_FACET`, `DEFAULT_FACET_LIMIT` and the `RefreshOptions`, `BackfillOptions` and `BackfillSummary` types are now exported.

### Patch Changes

- 1035eb1: Test-only: update a `DiscoveredTranscript` fixture in `refresh.test.ts` for the new required `account` field (TP-259). No source or behavior change.
- Updated dependencies [825b8b2]
- Updated dependencies [38903dd]
- Updated dependencies [283d7e1]
- Updated dependencies [1035eb1]
- Updated dependencies [a49eb2d]
  - @titan-design/store-sqlite@0.3.1
  - @titan-design/session-read@0.5.0

## 0.5.0

### Minor Changes

- e204012: `openSessionGraph` accepts an optional `schemaVersion`: the highest migration version the
  caller owns, checked before any migration runs. A product layering its own tables on the
  graph passes its own top version, since this package's migrations are one band of a shared
  database rather than the top of it.

### Patch Changes

- Updated dependencies [e204012]
  - @titan-design/store-sqlite@0.3.0

## 0.4.1

### Patch Changes

- Updated dependencies [1334f34]
  - @titan-design/session-read@0.4.0

## 0.4.0

### Minor Changes

- 11b94a2: Add bounded Codex execution, rollout discovery/decoding, and opt-in mixed-harness
  session ingestion with format-aware search excerpts and error readback. Preserve
  legacy Claude rows and references through additive conversation aliases. Prevent
  orphaned contentless FTS row IDs from leaking stale terms after source replacement.
  Recognize native shell missing-file diagnostics in error clustering.

### Patch Changes

- 81b60ee: Add graph-free Claude/Codex observation dispatch, source lookup, bounded recent-turn reads and session summaries. Share usage folding with graph queries and preserve native denial evidence separately from generic tool errors.
- Updated dependencies [11b94a2]
- Updated dependencies [81b60ee]
- Updated dependencies [25391fa]
- Updated dependencies [3bde552]
  - @titan-design/session-read@0.3.0
  - @titan-design/store-sqlite@0.2.1
  - @titan-design/cluster@0.1.2
  - @titan-design/locator@0.2.1
  - @titan-design/agent-protocol@0.1.0

## 0.3.2

### Patch Changes

- 0bdae32: Detect a rotation that did not shrink the file, and purge when the extractor rewinds itself.

  `resumePoint` now treats "same length as the watermark, but a newer mtime" as grounds to
  hash the prefix without being asked, since transcripts only grow. The cost lands on the
  few files that look wrong rather than on every file every pass, which is what makes
  `verifyHash` too expensive to leave on. `TranscriptEntry` gains an optional `mtime`;
  omitting it keeps the previous behaviour exactly.

  `indexTranscript` now honours `extractTranscript`'s `restartedFromZero`. The extractor
  re-hashes the prefix it was asked to skip and restarts from byte 0 when the bytes moved,
  and that answer was being discarded: the whole file replayed onto rows that were never
  removed, which is the accumulation `purgeTranscript` exists to prevent, reached by a
  different road.

- Updated dependencies [49360c2]
- Updated dependencies [8153dd8]
- Updated dependencies [0bdae32]
  - @titan-design/cluster@0.1.1
  - @titan-design/store-sqlite@0.2.0
  - @titan-design/locator@0.2.0
  - @titan-design/session-read@0.2.1

## 0.3.1

### Patch Changes

- a69ca96: Purge a rewritten transcript's derived rows before re-reading it from byte 0, and restore
  a `missing` transcript to `ok` when its file comes back.

  A rewind previously left the old rows in place: `session.turn_count`, the
  `session_model_usage` token buckets and the commit/push counts summed onto what was
  already there, and facts the rewrite removed persisted on their unique index. Separately,
  a transcript that vanished and returned unchanged took the `unchanged` fast path, so
  `advance()` — the only writer of status `ok` — never ran and the row stayed `missing`
  forever. Quarantined rows are deliberately still not cleared.

## 0.3.0

### Minor Changes

- aac3473: Add an optional `TaskResolver` seam to the refresh pass. A caller may pass `resolveTasks`
  to fill task `title`, `initiative` and present `status` from its own store; with no
  resolver the graph is unchanged and still rebuilds from transcripts alone. The resolver is
  called once per pass with every task id, its stated fields take precedence over
  transcript-derived ones while omitted fields keep them, and a resolver that throws costs
  that pass its enrichment only, reported as `summary.tasks.failed` with the `error` message.

## 0.2.0

### Minor Changes

- fc7b58e: Derive task status from transcript content. `parseTaskIntents` reads every
  `active-work`/`aw` task invocation in a compound command, not just one anchored at the
  start of the line, and reports the status the `done` and explicit `edit … status` forms
  state. Task events carry that status, the folder lets a closing mention upgrade an earlier
  read, and the graph writes it with a COALESCE that a later bare mention cannot erase.

### Patch Changes

- Updated dependencies [fc7b58e]
  - @titan-design/session-read@0.2.0

## 0.1.0

### Minor Changes

- fdb3339: Build the session activity graph on the store kit: `openSessionGraph` with kit + domain
  migrations, `applyDelta` (transactional writer with chunk-safe upserts and phase collapse),
  `rollupSessions` and `reconcile` (recompute-never-accumulate), `indexTranscript` /
  `refreshCorpus` with watermark resume, rewrite rewind, quarantine, and missing-source marking.

### Patch Changes

- d33d861: Extract Claude Code transcript reading from active-work's session miner as a storage-free
  event stream: `LineReader` (stateless per line, byte-offset locators), the `SessionEvent`
  union, `EventFolder` with chunk-boundary-safe merge rules, `readTranscriptEvents` /
  `extractTranscript` with prefix-hash resume, bash intent parsing, repo attribution, and
  transcript discovery including subagent sidechains. `session-graph` is stamped as a placeholder.
- Updated dependencies [fbf473b]
- Updated dependencies [d33d861]
- Updated dependencies [aa5f694]
  - @titan-design/locator@0.1.0
  - @titan-design/cluster@0.1.0
  - @titan-design/session-read@0.1.0
  - @titan-design/store-sqlite@0.1.0
