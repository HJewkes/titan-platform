---
"@titan-design/session-graph": minor
---

Add a `resolvePrs` option to `refreshCorpus` that fills PR state, merged_at, closed_at and review_rounds from a caller's forge after reconcile, never downgrading a merged PR. `ResolvedTask` gains `estimate`, stored in `task.estimate`. Add `replaceEpisodes`, the writer of the `episode` table, which replaces one heuristic's rows for one session. Document migration 5 and `syncPrices`.
