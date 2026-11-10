---
"@titan-design/session-analytics": patch
---

`readCoverage` counts only readable (status `ok`) transcripts in `facetBacklog`, and is exported, so a quarantined or missing file no longer inflates the backlog that `miner cost` and `miner status` both report.
