---
"@titan-design/session-miner": minor
---

Add `titan-miner graph-refresh`, a scheduled refresh of a graph another owner writes: it takes a non-blocking lock (exit 75 when held), runs the owner's incremental refresh, then runs a read-only `quick_check` and logs the newest session. Ship hourly systemd user units for it under `ops/systemd`.
