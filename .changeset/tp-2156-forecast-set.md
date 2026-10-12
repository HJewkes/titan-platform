---
"@titan-design/throughput": minor
---

Add `forecastSet(tasks, table, { seed, draws, closure, weekEffect })`: p10/p50/p80/p90 of a task set's total implementer hours, reviewer hours and USD, simulated from each task's class quantiles (linear between the knots, exponential tail above p90) with `seededRandom` from evidence. Per task it reports class, back-off level, `n` and closure rate, and it lists kinds the table has never seen as `unclassifiable` while still drawing them. Add `closureRates` and `closureFor` (recency-weighted share of `no-impl-session` closures, backed off like `classFor`; a closing task draws 0 h and $0) and `weekEffects` (per-week actual / class-p50 ratios normalised to mean 1, one week shared by every task in a draw). Output is identical for identical input in any task order.
