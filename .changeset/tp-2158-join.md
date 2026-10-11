---
"@titan-design/session-analytics": minor
---

`taskActuals` accepts optional `shepherdRuns` (the records `titan-factory shepherd stats --per-run --json` prints) and `shepherdSince`. When passed, each row gains `reviewRounds`, `stageMinutes`, `serviceWallHours` (first implementer request to the earliest merge) and `mergePath` (`shepherd`, `outside` when a merged PR has no run, else null), joined by task id and then by `repo#pr`. A row merged before `shepherdSince` gets null Shepherd facts.
