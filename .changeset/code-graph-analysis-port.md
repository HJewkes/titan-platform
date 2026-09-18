---
"@titan-design/code-graph": minor
---

Port codewatch's graph analyses into `src/analysis/` (TP-127, TP-128): dead-code and growth-risk metrics computed at index time and carried forward under reuse, PageRank, seeded relevance, and symbol co-import coupling. `snapshotPageRank`, `snapshotRelevance`, `snapshotSymbolConsumers`, and `snapshotSymbolCoupling` run each query-time analysis on a store and a snapshot id. `INDEX_VERSION` moves to 0.13.0, so the first index after upgrading re-parses every file instead of reusing a snapshot that lacks the new metrics.
