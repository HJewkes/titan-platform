---
"@titan-design/code-read": minor
---

Add optional `lenses` to `node.get` (contract 0.1.6, additive). `exports` lists a file's declared symbols with utilization, consumer count, and own cognitive complexity; `score` breaks the hotspot score at the node's grain into churn, complexity, recency, and utilization, with its rank, for a `window`; `centrality` gives every file in the reading order a PageRank score and a rank; `coupling` reports co-changed partners as `measured: false` until pairs are stored; `tests` lists path-linked tests beside the indexer's `linked_test_count`. A call with no lenses returns the same result as before. The reading order in `overview.get` and the centrality lens share one ranking.
