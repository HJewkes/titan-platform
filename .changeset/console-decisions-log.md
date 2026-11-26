---
"titan-console": minor
---

Add the Decisions and ships log at `#/log` (TP-6775). `log.list` merges the PRs Shepherd merged, Shepherd's auto-by-rec gate rows (read through `titan-factory shepherd by-rec --json`) and the console's own round and deposit rows. Rows are grouped by day, newest first, one per PR, each with how it was approved, the recommendation, rationale, times and a revert or overrule link. The header shows the by-rec mode, the wait and the exclusion floor, which has no remove control. The inbox shows when each eligible round or deposit goes with its recommendation, and the coordinator's What shipped section gets one line of counts linking the log.
