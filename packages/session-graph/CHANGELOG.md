# @titan-design/session-graph

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
