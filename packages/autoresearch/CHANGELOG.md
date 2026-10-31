# @titan-design/autoresearch

## 0.1.0

### Minor Changes

- cfdfb64: A planner answer whose final message held no JSON is now reported on the plan step as `malformed` and gets the same one resumed retry a quota miss does, with the parse error as its violation, instead of failing the run. The factory reads agents' final messages whole, so an answer past 16 KiB keeps its closing fence.

  `titan-factory autoresearch plan-dry-run <target>` runs only a round-1 planner turn on an empty digest and checks its ops against the parse, the queue-ops schema and the quotas, with no pin, baseline or implementer.

- cfdfb64: The plan port's input now carries `quota`, the context `quotaViolations` checks the answer against, and the new `quotaRules(quota)` words those quotas with their numbers for a planner brief. A round-1 quota retry now resumes the planner, so its brief carries the violations, instead of re-sending a spawn that joined the exited planner and replayed its first answer.
- 22f0205: Enforce `bounds.json` on real diffs. Add `parseUnifiedDiff`, `postCheck` (frozen, class, new-file, required-test, case-name, stray-literal and param checks, one recorded row each, plus the measured diff size), `changedParams` and `frozenOverlap`. `BoundsSchema` reads `integerParams`, `diff`, `test` and `banned` (each ban as prose or data, and a data-form `literalsOutsideConfig.allowed` list). `TargetSchema` reads `frozen`, and a class that names a frozen file stops the run before the baseline. A guard can now be `{slack, direction}`, so a `max` metric's guard rejects a fall. A winner within one σ of the strongest with a smaller source diff moves the ratchet. `ArResultSchema` keeps `rung`, `evaluator_pin` and `artifact_dir`. A blank `differsFrom` no longer clears a dead end.
- ad0d9b3: A round can keep more than one winner. The picked winner still fast-forwards the ratchet. Each later winner, in pick order, is merged onto the new head by the new optional `integrate` port (step `ar-integrate:<r>/<id>`), checked at L0 and run up the keep rung against the new B under its own scope (`<r>/re/<id>`). Only a winner that is still kept moves the ratchet, with `kind: "merge"` at `ar-ratchet:<r>.<n>`. A merge conflict, or a host without `integrate`, requeues the winner on its own lineage. Each decision is recorded as the seed `ar-reeval:<r>/<id>`. `RoundSummary` gains `moves` and `reevals`, both defaulting to `[]` so older runs still parse, and `ratchet` is now the net move. A settled outcome gains `reeval: {vs, decision, reason}`; a winner rejected on top of the new head settles as `rejected` with reason `reeval:<reason>`. `RatchetRequest.kind` is now `"ff" | "merge" | "sync"`, and `ideaId` is optional (for `sync`). Re-evaluation runs count in the run's model spend. `caseRungs` is exported from the ladder for re-use.
- a80e617: Add `@titan-design/autoresearch`: the autoresearch engine (queue, Thompson selection, fidelity ladder, noise-banded keep rule, registries, digest and the `mapItems` recipe) against `ArPorts`. It is target-agnostic: results are `ar-result/v2` with named `metrics`, `gates` and `violations`, and the keep rule reads the target's `metric` spec (`primary`, `guards`, `zeroTolerance`, `allGate`, `noOp`). Diff size is recorded on outcomes, never capped. Inspired by Andrej Karpathy's autoresearch (MIT); no code copied.
- 1732875: Add the engine contract real ports read. `TargetSchema` reads `repo`, `caseSets`, `runnerRoot`, `unitTests`, `testProof` and `rungs`, and `renderCommand` fills their templates. Eval keys are unique per run, ladder and repeat, and σ pairs are matched by position. Each ladder holds a recorded lane slot and gets an exploit or explore fork from the fork schedule. The `ar-stop` outcome records `against` (with `case` and an explicit `locked`), the implementer (`mode`, `account`), lane, fork, L0 rows, micro counts and usage. The ratchet input carries the move record, the micro input the best's `baselineDir`, the plan input a spawn or resume `mode`. New dispatch steps are `ar-load-wait` and `ar-archive`, with optional `loadWait` and `archive` ports. Dead-end and bug rows name their idea and round. **Breaking for port implementers:** `ImplementedSchema` requires `agent` and `mode`.
- 3ad8bee: Add the run read model, replayed from a run's recorded steps. `arRunView(run, looks)` returns the target with its metric projected to the console's names, the settings, the baseline, the best, every round's queue, planner, selection, ladders and ratchet move, the registries and cells replayed over the settled outcomes, the validator looks and the stop reason. Each ladder carries its recorded outcome whole, settled by `finalOutcomes`. `arRunSummary(run)` returns one runs-list row, and `ideaRefs(run, ideaId)` names the base and head an idea's diff spans. `cellTable` and `CellRow` are now exported.
- af2b1e0: Make autoresearch steps safe across a host restart. The eval, L0, L1 and ratchet steps now name the run and its recorded pin (`RunPin`: `runId`, `pin`, `frozenHash`), and the implement step names `runId`. `ArStepHandler.run` takes the runtime's `StepTiming`, and the load-wait handler passes the step's `firstStartedAt` to `loadWait`. The `plan` port now answers `{ ops, agent?, sessionId?, mode?, usage? }` (`PlannedSchema`), and the round record gains an optional `planner`.

  In the factory, the evaluator ports rebuild a run's session from the step's recorded pin after a restart and refuse with `[frozen-drift]` when the frozen files no longer hash to the recorded value. The load gate counts its optional `maxWaitMs` deadline from the step's first start. The planner reports its agent, session and usage. A `[tree-live]` failure is retryable. Implementers are named from the run id rather than the tree name.

- a50b511: Record what S4's readers need instead of keeping it in memory. Each round records `ar-summary:<r>` (best, against, kept and superseded ids, the ratchet move, the first planner answer's quota misses and whether it retried), and the run records `ar-end` with its stop reason and hands an `ar-registry:<phase>` row to the new optional `registry` port. Owner ideas enter through a recorded `ar-inbox:<r>` step and the optional `ownerIdeas` port, queued with `source: "owner"`. A new `autoresearch-validate` workflow (`runValidatorLook`) runs one milestone look through the optional `validate` port, whose strict aggregate refuses per-case keys; `target.json` gains `validator {runs, maxLooks}`. `finalOutcomes`, `RunSettingsSchema`, `ForkScheduleSchema`, `ProposalSchema`, `AgainstSchema` and the new record schemas are exported.
- b4b841b: Add snapshot cadence and the ar-sync recipe. A run with `snapshot` settings cuts a snapshot PR through the new optional `snapshot` port once enough ideas were kept or enough agent plus model dollars were spent, with one open at a time. While one is open, each round first syncs it through the optional `sync` port: a merged PR moves B onto main merged into the ratchet, re-measured when the tree changed, and a conflict or a frozen change holds the run at the `ar-sync-gate` assisted gate until the owner answers with a `resolved` sha. A run without `snapshot` settings records exactly what it did before.
- e90522a: Read concurrent winners, snapshots and syncs in the run read model. Each `ArRoundView` gains `moves` and `reevals`, and `ArRunView` gains `snapshots`, `snapshotPending` and `syncs`, all replayed from the recorded steps. `ArRunSummary` gains `openSnapshot`. A sync's B re-measure appears under that sync's `runs`, never in an idea's ladder. A run recorded before these steps reads with every new section empty.

### Patch Changes

- 3fdf506: Record a failed ar-sync as `ar-sync:<round>.failed` and keep the run going with the snapshot open, so the next round's
  sync retries it; a moved ratchet still stops the run. The read model shows each failure as an open sync with `failed`.
- 6b7ee32: The console's `#/autoresearch` run page reads and shows C-256 S5's read model. Each round lists its ratchet moves and the later winners measured again on the new head, with decision, reason and Δ. A new Snapshots section lists the snapshot PRs, any cut waiting behind the open one, and each sync with its state, conflicts, frozen paths, a failed sync's reason, gate and B's re-measure. The runs list names the open snapshot, and the idea record names a re-evaluation. `reeval:<reason>` reject codes now read as text. A factory from before S5 still parses, with every new section empty. A sync's re-measure never reaches a ladder, and no `sync` rung is admitted. In `@titan-design/autoresearch`, the console schema copies used by tests now carry these fields, which replace the proposed copies.
- 7492819: - **Count work in timing tests instead of reading a clock (TP-4262).** Glob growth tests compared thread CPU ratios, which read up to 415 on a loaded hosted runner and turned main red. fix-proof's `LinearRegExp` now counts its NFA steps (`linearRegExpSteps`), and test-kit's `linearWork` compares those counts across a size ladder. It replaces the timed `linearGrowth`, which is removed. A matcher that falls back to a backtracking RegExp counts nothing and fails at size 1. test-kit also adds `countCalls` and `callMeter`, which count calls to chosen methods and stop at a cap. fix-proof's brace and glob rows and code-graph's reach and link rows use them in place of millisecond limits.
  - **Refuse new clock limits in tests.** eslint-plugin adds `no-test-clock-budget`. It reports a test that compares a clock reading, or a ratio of readings, with a limit outside a bench gate. The repo enables it with a shrink-only baseline that TP-4264 empties.
- 7a34209: The remaining RegExp glob compilers match in time linear in the path (TP-4223). fix-proof exports `LinearRegExp`, also from `@titan-design/fix-proof/linear-regexp`: a RegExp whose `test` simulates its source as an NFA, so a glob such as `d/` and twenty `*`, or `**/` repeated twelve times, can no longer hang a match. review-panel's `matchesGlob`, autoresearch's bounds globs, code-graph's `patternToRegex` and `.gitattributes` patterns, and tool-guard's merge-lint `globToRegExp`, guarded path patterns and glob command words now build one. Each still returns a RegExp and matches what it did, except that a glob too large for V8 to compile, which used to throw at its first test, now matches as written. test-kit exports `linearGrowth`, a growth-ratio ladder that fails a polynomial matcher on a small input before trying a large one, and `hostileGlobs`, the timing rows of tp#2491.
- Updated dependencies [7492819]
- Updated dependencies [2256a3b]
- Updated dependencies [9c70c14]
- Updated dependencies [708e154]
- Updated dependencies [6a2471a]
- Updated dependencies [56d107b]
- Updated dependencies [0848c31]
- Updated dependencies [136b507]
- Updated dependencies [f5d92f3]
- Updated dependencies [7a34209]
- Updated dependencies [bea67f1]
- Updated dependencies [36dc03f]
- Updated dependencies [661a027]
- Updated dependencies [9b42150]
- Updated dependencies [4080191]
- Updated dependencies [661cf66]
- Updated dependencies [869014a]
- Updated dependencies [32637bd]
- Updated dependencies [2451aa9]
- Updated dependencies [d2cce6c]
- Updated dependencies [719f05e]
- Updated dependencies [4a2495f]
- Updated dependencies [0229ba6]
- Updated dependencies [ee64f09]
- Updated dependencies [2165cec]
- Updated dependencies [50fd2a5]
  - @titan-design/fix-proof@0.9.0
  - @titan-design/workflow@0.14.0
  - @titan-design/rpc-client@0.4.2
