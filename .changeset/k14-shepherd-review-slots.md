---
"@titan-design/factory": minor
---

Shepherd exports its reviewer-slot reading (TP-2828). The spawn gate keeps the last roster reading of running `rv-` reviewers, and serve reports it in `/health` as `reviewSlots: { running, cap, readAt }`. A failed roster read keeps `rosterError` and no `running` list. `shepherd status --json --deploy` carries the block as `reviewSlots`, or `null` when serve has none. Text `shepherd status` ends with `reviewers R/cap`, or `reviewers unread (<why>)`, never 0.
