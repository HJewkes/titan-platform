---
"@titan-design/active-work": minor
---

Index planning records as a `plans` workspace class (TP-5453 P10). Outcomes, bets and intent digests under an initiative's `plan/` folder get spans in the workspace index, so `context related` returns a bet's outcome and intent lines. Owner-only initiatives index none of them. Adds migration 1004 (`plan_record`).
