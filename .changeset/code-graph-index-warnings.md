---
"@titan-design/code-graph": minor
---

Carry git-history warnings from `indexPaths` into a new optional `IndexResult.warnings`, and add `assembleIndexerMetrics`, which returns the metrics with those warnings. A churn log overflow or git failure was previously dropped.
