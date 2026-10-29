---
"@titan-design/session-graph": minor
---

`session_origin` gains eleven `route_*` text columns (mode, source, prior, reason, requested, wanted, workflow, table, facts, candidate, candidate wanted) and `ResolvedOrigin` gains the matching `route*` fields, so a spawn's routing decision can be joined to its outcome. Migration 15 adds them to an existing database.
