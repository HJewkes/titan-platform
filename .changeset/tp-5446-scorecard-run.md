---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
---

Add the ticket scorecard job (TP-5446 slice S2). session-miner gains `titan-miner ticket-scorecard run [--rebuild] [--dry-run]`. It reads events.db, factory.sqlite3, the graph, the task files (archive included) and the inferred-labels file, all read-only. It keeps per-source watermarks and recomputes only the dirty tasks. It snapshots each ISO week's rule-ready pool once, freezes closed weeks to `weeks/<week>.json`, and reports a closed week that recomputes differently as drift without overwriting it. Each pass is logged to the `run` table. session-analytics adds Shepherd phase medians per week (`phaseWeeks`, `upsertPhaseWeeks`, `readPhaseWeeks`, store migration 2), `recordRun` and `clearDerivedRows`.
