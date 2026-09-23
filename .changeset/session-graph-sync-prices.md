---
"@titan-design/session-graph": minor
---

Add `syncPrices(graph, rows, { tableVersion, source })`, which replaces every `price` row in one transaction so `request_cost` never reads a half-written table. `PriceInput` matches session-analytics' `PriceRow`, so `PRICE_TABLE` passes straight through without session-graph depending on session-analytics.
