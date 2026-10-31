# @titan-design/throughput

## 0.3.2

### Patch Changes

- 3157198: Check the package's own `version` at import instead of casting it; a manifest without a string version now throws at import.
- Updated dependencies [eaa03c2]
- Updated dependencies [67aa361]
  - @titan-design/evidence@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [41fce70]
  - @titan-design/evidence@0.4.0

## 0.3.0

### Minor Changes

- b6a1d02: Add `backtestSets(actuals, { origins, horizonDays, memberships, seed, draws, minSetSize, open, config, weekMinTasks })`: a rolling-origin back-test of `forecastSet`. At each origin it refits the class table, closure rates and week effects on rows done and started before it, then forecasts every seat-week, parent and milestone group whose first member starts in the horizon, with and without the week effect (closure off for seat-week groups). Per group kind it reports Wilson coverage of [p10, p90] for implementer hours, reviewer hours and USD, pinball loss on implementer hours, and groups censored by an open member; `groups` lists each scored group's actual and forecast totals.
- 491685f: Add `forecastSet(tasks, table, { seed, draws, closure, weekEffect })`: p10/p50/p80/p90 of a task set's total implementer hours, reviewer hours and USD, simulated from each task's class quantiles (linear between the knots, exponential tail above p90) with `seededRandom` from evidence. Per task it reports class, back-off level, `n` and closure rate, and it lists kinds the table has never seen as `unclassifiable` while still drawing them. Add `closureRates` and `closureFor` (recency-weighted share of `no-impl-session` closures, backed off like `classFor`; a closing task draws 0 h and $0) and `weekEffects` (per-week actual / class-p50 ratios normalised to mean 1, one week shared by every task in a draw). Output is identical for identical input in any task order.
- 228fd31: Add `reviewTable`, `reviewFor` and `reviewAblation`: recency-weighted quantiles of reviewer agent-hours, review rounds and post-PR wall hours, keyed on review class x lead touch with back-off, and a rolling-origin ablation of that key against kind x size band. `ThroughputRow` gains optional `prClass`, `touches`, `changedLines`, `reviewRounds` and `stageMinutes` (TP-2162 b).

### Patch Changes

- Updated dependencies [5cd4f1b]
- Updated dependencies [abadd64]
  - @titan-design/evidence@0.3.0

## 0.2.0

### Minor Changes

- dc1d669: Add `backtest`: a rolling-origin back-test of `classTable` that reports 80% interval coverage with Wilson intervals, pinball loss, median log error and Spearman per class and overall, against three baselines, with censoring counts, the 150k context line and a conformal widening factor from the previous origin. `ThroughputRow` gains optional `firstImplAt` and `peakContextTokens`.

### Patch Changes

- de21f12: Regenerate the committed API surface snapshots so they match the current exports; no source change.

## 0.1.1

### Patch Changes

- 702881e: Add internal back-test scoring metrics (interval coverage with a Wilson interval, pinball loss, median absolute log error, Spearman, 150k-context precision and recall, conformal widening factor) and depend on `@titan-design/evidence` for the Wilson interval. Not yet exported; `backtest` lands in a follow-up.

## 0.1.0

### Minor Changes

- 60d12aa: Add `@titan-design/throughput` with `classTable` and `classFor`: recency-weighted (21-day half-life) p10/p50/p80/p90 of implementer hours, reviewer hours and USD per kind x size band, backing off kind, size band, initiative, then global below 20 weighted rows. The table carries a model hash, the snapshot watermark and the package version.
