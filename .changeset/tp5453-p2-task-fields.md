---
"@titan-design/pm": minor
"@titan-design/active-work": patch
---

Add the optional task fields `bet`, `fold` and `owner_steps` to `TaskSchema`, with `BetLookup` and `betProblem` for the write-time check that a task's bet exists. active-work's `task add` and `task edit` refuse a task naming a bet the lookup does not know (TP-5453 P2).
