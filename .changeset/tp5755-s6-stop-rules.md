---
"@titan-design/factory": minor
---

`dispatch shadow-tick` judges the stop rules: `task-fix-cap` (with `next: planner-once` or `park`), `task-spend-cap`, `bet-parked` (with `would_ask`), `bet-followups` and `programme-checkpoint`, as `stage: "stop"` rows. The rule file's `stop` thresholds take their starting values when absent. Stop marks are read from `state/stops.json` beside the shadow dir and never written.
