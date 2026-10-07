---
"@titan-design/factory": patch
---

Shepherd no longer opens a main-red gate for a backlogged main run. At the wait limit it reads the newest completed main push containing the merge, and re-checks up to 3 more windows while a run is still queued or in progress. When no completed run contains the merge it opens `main-ci-timeout`, naming the missing run, so a backlog is not read as a red.
