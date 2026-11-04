---
"@titan-design/factory": patch
---

The owner digest's Seats section now counts merges and spawns per coordinator from the broker roster's spawned-by chains, instead of the seat book's dispatch journals, which no longer get written. The Spend section reads agent-chat's `pace.json` instead of `agent-chat digest --json`, which the installed agent-chat does not offer. `digest.logsDir` still loads but is no longer read.
