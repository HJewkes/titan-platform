---
"@titan-design/session-miner": patch
---

`titan-miner throughput pr-backfill` caches each merged PR's head sha and changed files (paths and line counts, no diff text) in `<state>/pr-diffs.json`, mode 0600, through `@titan-design/github`: cached refs cost no calls, a 404 is cached as missing, a capped file list is marked truncated, and the run stops at the rate floor with progress saved. `readPrDiffCache` returns the map `taskActuals` takes as `prDiffs` (TP-2162 c).
