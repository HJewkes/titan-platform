---
"@titan-design/factory": minor
---

Report time per stage. `shepherd status` shows each live PR's stage (queued, ci, review, re-review, hold, land), the minutes in it and the minutes since registration, as `stage` and `totalMinutes` in `--json`. `shepherd stats` adds, per repo and ISO week, the median, p90 and maximum minutes per stage, including re-reviews after a head move, as `stageTimes` in `--json`.
