---
"@titan-design/factory": minor
---

Add the dispatcher shadow's ready-stock trigger (TP-5964). A rule-file lane may set `floor` and `coordinator`. After each `dispatch shadow-tick`, a floored lane's dispatchable tasks are counted by the work-supply census rule (open, `brief:ready`, and no owner, needs-decision, parked, blocked, plan-first or superseded class). Below the floor, the tick sends one refill request with the count and the floor to the lane's coordinator, or to `compare.operator` when it names none, at most once per lane per UTC day (`<shadow dir>/refill/<day>.jsonl`). Floors are absent by default, so the change is inert until a rule file sets them.
