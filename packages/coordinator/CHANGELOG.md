# @titan-design/coordinator

## 0.6.0

### Minor Changes

- 74fe992: `EDITABLE_FIELDS` rows may carry any zod schema, not only a number: `bounds` is now optional and present on numeric rows only, and `checkEditableValue` returns an `EditableValue` (number, string or string list). Add factory rows marked `live`: `shepherd.gateReset.noReproProceed` and `heldRepair` (`off`/`on`), `twoMergeRelease` (`off`/`shadow`/`on`), `shepherd.review.adversaryProfile` (one profile name), `shepherd.review.fallbackConfigDirs` (up to 16 absolute paths) and `shepherd.review.maxConcurrent` (1..64). Add `shepherd.spawnGate.buildLoad5` beside `load5`, both still `restart`. Paths the factory writes, secrets and any other `shepherd` key stay not editable.
- 1640772: Shepherd: `shepherd.taskClose` picks when a merged PR closes its `--task` (TP-4274). `keep`, the default when absent, closes it on every merge as before. `last-slice-only` closes it only on the last slice: a `Last slice: yes` line in the PR body, `shepherd register --last-slice`, or no other open PR registered with the same task and no `Last slice: no` line. Otherwise the task stays open and gains a `slice merged: <owner/repo>#<n> at <sha>` note. Migration 43 adds the registration's `last_slice` column. The coordinator adds `shepherd.taskClose` as a live editable factory row.
- f1d79a5: Load is now the only limiter for factory spawns. The spawn gate's `windowMs` and `headroomIntervalMs` default to 0 and reload live, like `load5`. Coordinator's editable fields list both as live factory rows (0 to 3,600,000 ms). `burstMax` meant nothing without a window, so a config that still sets it fails to load with a message saying to remove it. When the gate would admit a review, any asker within the first N of the queue goes, where N is the free review slots the load check also allows. Fixers still sort first, then the oldest intent. A review counts as unabsorbed from the moment it is admitted until the roster shows it running, so a burst can no longer overshoot `buildLoad5`. A queued ask whose PR moved to a new head, or left the open list the PR snapshot already read, leaves the queue at once instead of aging out.

### Patch Changes

- 6889f5d: `EDITABLE_FIELDS` marks the factory rows `shepherd.spawnGate.load5` and `buildLoad5` as `live`: the factory now reads them through its reloadable config instead of once at start.
- f15a84e: Add `shepherd.gateReset.nonSourceNoRepro` (`keep-owner` when absent, today's behaviour). With `record-fact`, a fix-proof NO_REPRO on a non-security PR that changes no source goes to review marked unverified `no-repro-non-source`, and no `sh-sent-back` owner gate opens; the merge grant is unchanged. No source means the fix-proof plan, under the trusted configs, sorts no path as source, or the diff is the workflow-only diff a CI proof read. `@titan-design/review-panel` exports `noReproProceedOf`, the one reading of which unverified standings proceed and on what, so the brief rule, the tests member question and the panel plan all follow it. The row is live-editable (TP-4275).
- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- e63d1a9: Replace unsafe type assertions in the coordinator package with real narrowing.
- Updated dependencies [59db533]
- Updated dependencies [c1af4ba]
- Updated dependencies [73c018b]
- Updated dependencies [74ad076]
- Updated dependencies [81395d7]
- Updated dependencies [9411e94]
- Updated dependencies [dcbf00e]
- Updated dependencies [e391005]
- Updated dependencies [d0d51f1]
- Updated dependencies [f85e2ba]
- Updated dependencies [b7c8320]
- Updated dependencies [292fbe9]
- Updated dependencies [ed8310b]
- Updated dependencies [fa9516b]
- Updated dependencies [26598f3]
- Updated dependencies [792265b]
- Updated dependencies [db5ea61]
- Updated dependencies [2380fd4]
- Updated dependencies [a20c348]
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [8e09d50]
- Updated dependencies [5f33d7a]
- Updated dependencies [cb470f4]
- Updated dependencies [fcb7e85]
- Updated dependencies [3d709d8]
- Updated dependencies [4eb9812]
- Updated dependencies [9028bd0]
- Updated dependencies [9396ce4]
- Updated dependencies [29062e0]
- Updated dependencies [9d74995]
  - @titan-design/agent-dispatch@0.10.0
  - @titan-design/rpc-protocol@0.4.0

## 0.5.3

### Patch Changes

- Updated dependencies [d82852a]
  - @titan-design/agent-dispatch@0.9.0

## 0.5.2

### Patch Changes

- 48fc4c0: Add `EDITABLE_FIELDS`, the allowlist of config fields an editor may change (path pattern, bounds, reload class), with `editableField` and `checkEditableValue`. A path no row matches, such as a seat's `grants_extra`, is not editable.

## 0.5.1

### Patch Changes

- 7a4d313: Add the coordinator document revision log: `configRevisionSchema`, `applyEdit` (sets one schema-declared field on a copy and re-checks the document), `diffDocuments`, `documentSha`, `revisionSha` and `verifyChain` (refuses a log whose revision does not name the previous revision as its parent).

## 0.5.0

### Minor Changes

- 9ebb9ba: Add `authoredBlockSchema`, `parseAuthored` and `renderAuthored` for the seat's authored handoff block (TP-2896 a): parse never throws and caps the JSON text at 1,500 chars; render drops standing rules past their `expires` UTC day and omits empty sections.

### Patch Changes

- 741313f: Make charter `worktrees_per_repo_per_seat` optional
- Updated dependencies [3189a46]
- Updated dependencies [556b5e2]
- Updated dependencies [06506bc]
- Updated dependencies [8f81511]
- Updated dependencies [7330b11]
- Updated dependencies [0acca69]
- Updated dependencies [ca0dd12]
- Updated dependencies [ca0dd12]
- Updated dependencies [ff27157]
  - @titan-design/agent-dispatch@0.8.0

## 0.4.2

### Patch Changes

- Updated dependencies [3199c5a]
  - @titan-design/agent-dispatch@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [2b1640a]
  - @titan-design/agent-dispatch@0.6.0

## 0.4.0

### Minor Changes

- 7f4b402: Add `resolveSeatPolicy`: a seat's effective hard stops and scorer defaults. A seat may override a charter default through the new seat `defaults` key, and its `kind_weights` and `share_caps` merge key by key. A seat can only add hard stops and only lower `stop_short_factor`, so a global hard stop is never removed.

## 0.3.0

### Minor Changes

- 7a03e62: Add `HARD_STOPS` and `hardStopsIn`: one detection pattern for each of the twelve hard-stop classes, so hosts share a single detector.

## 0.2.0

### Minor Changes

- c389cbc: Add `coordinatorConfigSchema` and `checkCoordinatorConfig` for the `titan-coordinator/v1` document: owner, repos, seats, limits and policy in one file. Seats reuse `seatConfigSchema`, policy reuses the charter hard stops and defaults, and limits is agent-dispatch's `limitsSchema`, now a dependency. The check never throws and names the key path of each cross-reference error: an unknown pool (on a seat or anywhere in `limits`), repo or hard stop, a `limits.seats` entry for no seat, an unshared repo, a duplicate prefix, a seat `config_dir`, and anything other than exactly one attended seat named by `owner.seat`.
- cecc652: Add `importAutonomyTree` and `renderSeatBook`. The import turns parsed charter front matter, parsed seat front matter and a limits block into a `titan-coordinator/v1` document: repos move to the top level by id (identical entries share an id and gain a `shared_with` list when two seats use them; a repo two seats list differently keeps one id each), `config_dir` moves to the pool and the charter's hard stops and defaults become the policy. The render turns a document back into the seat files, restoring `config_dir` from each seat's pool. Both take parsed objects and read no files.

### Patch Changes

- d3b06a4: Ship `examples/single-seat.json`, a neutral `titan-coordinator/v1` starting point: one attended operator seat, one repo, one pool and conservative limits. It passes `checkCoordinatorConfig` and a test scans it for owner data.

## 0.1.0

### Minor Changes

- 2789dfd: Add `charterPolicySchema` and `parseCharterPolicy` for `autonomy-charter/v1` front matter: seats, hub, the twelve hard-stop classes and scorer defaults. Pools and funds pass through untyped. The parse never throws; errors name the missing or invalid key path.
- 5faeb32: New tier-2 package with the zod seat config schema (`autonomy-seat/v1`) and its inferred types. Pure code: no fs, process, network or broker. Unknown seat keys pass through.
- 2b94628: Add the `SeatState` schema, the seat event union (`seatEventSchema`) and `foldSeatEvents`, a pure fold from a seat's event log to its state: generation, agents, holds, claims, background commands and the authored block. Claims and holds are replaced by their latest event; a background command under `/tmp`, `/private/tmp`, the passed `tmpdir` or a `scratchpad` directory is refused into `errors`; unknown event kinds are counted, never thrown.
- 5273f3b: Add `projectSeatGeneration`, a pure projection of a seat generation to one `SessionFacts` record per initiative it touched.
