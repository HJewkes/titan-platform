---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
"@titan-design/factory": patch
---

Move the return-contract report parser into session-analytics. `parseReport` now lives there, reads the `Head:` sha and the `CI:` paste (worst state first) as well as the status, PR, plan, PARKED line and proposed tasks, and accepts a sentence after the status word (`Status: DONE. Plan: ...`). session-analytics also exports `extractFriction`, `extractConcerns`, `lineCluster` and `clusterOf`. factory keeps only the `burndown-slices` reader. session-miner gains `titan-miner report intake --shadow [--since 24h] [--eval]`, which writes one row per worker report (status, PR, head, CI, concern classes, suggested actions), acts on nothing, and with `--eval` scores the suggested closeouts against what happened next in the event log.
