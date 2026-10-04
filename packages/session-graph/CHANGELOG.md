# @titan-design/session-graph

## 0.13.0

### Minor Changes

- c67ee7a: Migration 9 stops storing bulk classes. A graph no longer has an `artifact` table, and the `normalized_*` tables exist only when `openSessionGraph` is given `normalized: true` (they are dropped only while empty, so a graph that holds rows keeps them). This changes the default: callers that read or write the Codex path must pass `normalized: true`. `resetIndex` clears only the tables that exist, `markMissing` no longer reads `normalized_source` when it is absent, and `refreshCorpus` accepts `present` source keys that count as existing without being visited. Adds `session_state`, `ensureNormalizedSchema` and `derivedTables`.

### Patch Changes

- ed058da: `refreshCorpus` expands a leading `~/` (or a bare `~`) in a stored source key before checking whether the file still exists, so transcripts keyed under the home directory no longer flip to missing. A new `homeDir` option overrides the OS home directory.
- 30e1fdf: Expand a leading `~/` in a legacy source key before `readIndexedText` reads its spans; the new optional `homeDir` option defaults to the real home directory.

## 0.12.1

### Patch Changes

- Updated dependencies [fe11f1b]
  - @titan-design/agent-protocol@0.4.0
  - @titan-design/session-read@0.8.1

## 0.12.0

### Minor Changes

- 394bfae: `reconcilePrices` upserts a price table into a graph without deleting other rows: it adds missing models, updates changed rates and stamps the table version. `titan-miner` calls it with session-analytics' `PRICE_TABLE` whenever it opens the graph, so `titan-miner refresh` fixes a graph that still prices `claude-opus-5-5` at Opus 5 rates.
- 0a9d26c: `openSessionGraph(path, { readonly: true })` opens a graph another process owns without migrating it, and throws `SessionGraphNotMigratedError` when it lacks a session-graph migration. The session miner reads such a graph with `--graph <file>` (`TITAN_MINER_GRAPH`), and its own migrations move from 1000-1002 to 2000-2002 so they no longer collide with active-work's band at 1001. A miner database migrated at the old numbers re-applies the new ones idempotently.

### Patch Changes

- Updated dependencies [88bf9f7]
- Updated dependencies [c583709]
- Updated dependencies [f3f843d]
  - @titan-design/session-read@0.8.0

## 0.11.0

### Minor Changes

- 661244b: Prompt spans no longer index injected context (TP-108). A user line that session-read classifies as not typed by a human (hook and bootstrap output, peer channel messages, task notifications, compaction summaries) indexes no prompt span. A line whose `promptSource` is `sdk` (spawned agents, and `claude -p` runs) indexes no prompt span unless the caller passes `indexSdkPrompts: true`. Typed prompts lose system reminders, channel and hook blocks, command framing and output echoes when those blocks sit on their own lines, and framed agent-chat spawn briefs are dropped whole. `readIndexedText` strips prompt excerpts the same way. `stripInjected`, `isInjectedCause` and `isUntypedPrompt` are exported. Structural rows are unchanged; run `resetIndex` to rebuild an existing index under the new rule.

### Patch Changes

- Updated dependencies [661244b]
- Updated dependencies [0bf3f20]
  - @titan-design/session-read@0.7.0

## 0.10.0

### Minor Changes

- 5c53f2e: Store and project the task a spawn record assigned. `ResolvedOrigin` gains optional `taskIds` and `taskSource` (typed `TaskLinkSource`). Migration 7, `origin task link` (exported as `ORIGIN_TASK_LINK_MIGRATION_NAME`), adds the matching `session_origin` columns and changes no existing row. `sessionsNeedingOrigin` now also offers a row whose `task_source` is null. A resolver that sets `taskIds` always stores a source, or `none` (`NO_TASK_LINK`) when it found no id, so the row is not offered again. The origin upsert now updates only the columns it names instead of replacing the row. A resolver that omits `taskIds` leaves a stored task link as it was; a task-aware resolver should return an entry for every session it examined, with empty `taskIds` when nothing links, or the session is offered again. Each linked id projects a `task` row and a `ran` edge with `attrs.via = "origin"`; a re-resolution that drops an id expires only that origin-made edge. A transcript that asserts a `ran` edge the origin made first supersedes it without `via`, so origin expiry never removes a transcript's claim.
- c7d5b1a: Count review rounds over agent-chat verdicts and forge reviews under one rule. `ResolvedPr` gains optional `reviews` (`ResolvedReview`), which replace the PR's forge rows in `pr_review`; `review_rounds_gh` is then counted by the rule against the sent or stored commit times. New `projectReviewRounds` (run by `refreshCorpus` after `enrichPrs`) resolves each chat verdict's `pr_ref` by exact repo, repo hint, the sender's family links, then the sender's working directory repo, and writes `review_rounds_chat` and `review_rounds`. A changes-requested review counts when a later commit answered it, once per head across reviewers and surfaces; an approval never counts. Chat verdicts count only from senders whose profile passes the new `isReviewerProfile` refresh option (default `reviewer` or `*-reviewer`). `RefreshSummary` gains `reviews: { resolved, unresolved, invalidTimes }`. A review whose time does not parse is ignored; a PR with any unparseable commit time is treated as having unknown commit times. Chat row keys now take their ordinal from the `review_verdict` event; an event from an older session-read with no ordinal takes the next index its tool use has not used in that call. With a count-only resolver, `review_rounds` is an upper bound. Also exports `countRounds`, which returns null when a commit time does not parse.
- 26f97c0: Store review verdicts parsed from agent-chat messages. Migration 8, `review verdicts` (exported as `REVIEW_VERDICT_MIGRATION_NAME`), adds the `pr_review` table (`REVIEW_TABLE`, `REVIEW_DDL`) and the `pr` columns `review_rounds_gh`, `review_rounds_chat` and `commit_times`; it copies `review_rounds` into `review_rounds_gh` and re-queues every PR for the outcome resolver once. `applyDelta` writes one chat row per `review_verdict` event, keyed `chat:<tool_use_id>:<n>`, holding only parsed fields; `purgeTranscript` and `resetIndex` clear them. `ResolvedPr` gains optional `commitTimes`, stored as a JSON array; an omitted field leaves the stored value. `prsNeedingOutcome` also offers a merged PR whose `commit_times` is null, ordered after never-checked and open PRs. A resolver's `reviewRounds` now also sets `review_rounds_gh`.

### Patch Changes

- Updated dependencies [b8a5614]
- Updated dependencies [15eaffa]
- Updated dependencies [2983591]
- Updated dependencies [b1e1c70]
- Updated dependencies [d019c72]
- Updated dependencies [c7d5b1a]
- Updated dependencies [d0ce38a]
- Updated dependencies [d0ce38a]
  - @titan-design/agent-protocol@0.3.0
  - @titan-design/session-read@0.6.0

## 0.9.1

### Patch Changes

- Updated dependencies [ca56251]
- Updated dependencies [18527b6]
- Updated dependencies [3f935f3]
- Updated dependencies [4761f82]
  - @titan-design/agent-protocol@0.2.0
  - @titan-design/session-read@0.5.1

## 0.9.0

### Minor Changes

- 5b4f9de: Add `start_transcript_id`/`end_transcript_id` to the `episode` table (migration 6, "episode transcript ids") and thread `transcript_id` through `session-analytics`'s episode input so a session resumed across two transcripts still segments in time order instead of falling back to byte offsets that reset with the new file.

## 0.8.1

### Patch Changes

- 6cfbe00: `RECONCILE_PR_MERGES` no longer overwrites `merged_at` once a PR's outcome has been forge-checked (TP-310); a transcript sighting time can no longer clobber a forge-accurate merge time on a later rollup pass.

## 0.8.0

### Minor Changes

- 527b81e: Add a `resolvePrs` option to `refreshCorpus` that fills PR state, merged_at, closed_at and review_rounds from a caller's forge after reconcile, never downgrading a merged PR. `ResolvedTask` gains `estimate`, stored in `task.estimate`. Add `replaceEpisodes`, the writer of the `episode` table, which replaces one heuristic's rows for one session. Document migration 5 and `syncPrices`.
- da2f8d9: Add `syncPrices(graph, rows, { tableVersion, source })`, which replaces every `price` row in one transaction so `request_cost` never reads a half-written table. `PriceInput` matches session-analytics' `PriceRow`, so `PRICE_TABLE` passes straight through without session-graph depending on session-analytics.

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
