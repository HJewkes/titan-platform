---
"@titan-design/factory": minor
---

`titan-factory scorecard --spec <file> [--since YYYY-MM-DD] [--until <time>] [--json]` prints the factory scorecard: the ledger rows (merges per day, task ready to merged, register to merge, change failure rate, time main stays red, seat merge share, approved and waiting over 60 minutes) plus session-analytics' journal rows, with each row's baseline and target read from the spec. A row with no source prints `not measured`; a missing spec or unset `AUTONOMY_ROOT` and `ACTIVE_ROOT` exits 2.
