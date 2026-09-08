# @titan-design/session-graph

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
