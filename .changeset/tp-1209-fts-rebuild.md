---
"@titan-design/store-sqlite": patch
"@titan-design/session-graph": patch
---

`SpanFtsTables.index` now re-inserts the FTS row of a span whose row `clearIndex` removed, so `clearIndex` followed by re-indexing every surviving span rebuilds the index instead of leaving it empty. session-graph documents why `resetIndex` still deletes the span table.
