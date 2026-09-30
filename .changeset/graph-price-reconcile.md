---
"@titan-design/session-graph": minor
"@titan-design/session-miner": patch
---

`reconcilePrices` upserts a price table into a graph without deleting other rows: it adds missing models, updates changed rates and stamps the table version. `titan-miner` calls it with session-analytics' `PRICE_TABLE` whenever it opens the graph, so `titan-miner refresh` fixes a graph that still prices `claude-opus-5-5` at Opus 5 rates.
