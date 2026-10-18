# @titan-design/coordinator

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
