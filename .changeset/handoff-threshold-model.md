---
"@titan-design/session-analytics": minor
---

The cost report gains `handoffThreshold`: per role and model, the boot cost and fill (up to the first dispatch, send or file write), the mean fill growth per request and the cache-read price, all fitted from the requests and priced from `PRICE_TABLE`. It sweeps the handoff threshold K for the cheapest cost per request (boot / n + read price x mean fill), reports the extra cost at each configured K and a half-boot sensitivity row, gives each teleport's exit fill from broker log lines the caller passes as `brokerLogLines`, and compares fresh per-PR reviewers against one standing reviewer. The text renderer prints three new sections. New exports: `handoffThreshold`, `sweepK`, `costPerRequest`, `isBootAction`, `parseTeleportEvents`, `handoffThresholdSchema` and their types and defaults.
