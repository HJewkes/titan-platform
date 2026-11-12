---
"@titan-design/session-read": minor
"@titan-design/active-work": patch
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
"titan-console": patch
---

Link scorecard dispatches through the session origin when a spawn recorded no task (TP-5446 slice S12). session-read's `assignedTaskIds` takes an optional `spawnTask`, the spawn's recorded `meta.task`; a known id there wins over the name and brief rules and reports source `spawn-meta`. active-work's agent-chat origin resolver passes it. session-analytics' `ScorecardSpawn` gains an optional `link` provenance; a first dispatch linked by inference records it under `provenance.firstDispatchTs`, so the row counts toward the week's inferred share. session-miner's `ticket-scorecard run` falls back, for a spawn with no `meta.task`, to the session graph's resolved `session_origin` link when it names exactly one task, marked `inferred:<task_source>`; a link naming several tasks or none is left unlinked and counted. `run` prints those counts, and `reproduce` adds a per-week table of the population and the share of its rows whose dispatch link is inferred. The console's task drill-down shows the inferred badge on the first dispatch.
