---
"@titan-design/factory": minor
---

`digest run` writes `owner-gate-alarm.md` beside the digest when the stale-gate alarm fires and removes it when it does not. Planner inputs gain `optional` (an absent file reads as empty) and `prompt` (a brief line shown while the input has text), so the planner review can read the alarm and be asked for a cause fix (TP-4546, TP-4368).
