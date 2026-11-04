---
"@titan-design/factory": minor
---

TP-4759 S2 (owner decision 552): a dead-end seat gate offers `replan`. The answer runs the new `sh-replan` step, which spawns `shepherd.replanProfile` (default `bd-planner`) with a brief naming the task, PR, head, kind, each failed session with its transcript path, and the FIX_FIRST trail; the planner reports to the seat and the run waits for a new head. A refused spawn tells the seat why and asks again with replan no longer recommended. Respawn stays recommended until its cap, then replan is, so the gate keeps a menu once respawns are spent. Behind `GATE_DEMOTIONS.deadEndSeat`, still off.
