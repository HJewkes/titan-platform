---
"@titan-design/active-work": minor
---

Let handoffs and teleports carry loops (TP-4316 A2). `loop open --origin handoff|teleport|wrap --seat <name>`
records where a loop was filed and which seat owns it. `loop board` and `loops <slug>` list such a loop with
`source: handoff` or `teleport` and its owning seat. A seat's newest handoff or teleport in the session index,
when newer than a loop's last motion, advances that loop's `lastMotion` and `daysSinceMotion`.
