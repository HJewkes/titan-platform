---
"@titan-design/session-analytics": patch
"@titan-design/session-miner": minor
---

Add `titan-miner ticket-scorecard reproduce` (TP-5446 slice S4). It rebuilds the scorecard's task rows in memory, read-only on every store, and prints a pass/miss table against the 2026-11-12 hand audit's figures (`e1-expected.json`) with the plan's tolerance table. A figure the rows cannot give yet is shown as not measured, with the reason. The inferred-labels reader accepts an optional `class_raw` (product, upkeep or mixed), used only where the audit ranked mixed separately. session-analytics: fix rounds now count a suffixed step id (`sh-await-new-head:<n>`) by its family, so every caller counts live step ids correctly.
