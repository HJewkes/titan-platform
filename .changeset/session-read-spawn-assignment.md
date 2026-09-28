---
"@titan-design/session-read": minor
---

session-read: add `assignedTaskIds({ agentName, brief, isKnown })`, which reads the task ids a spawned session was assigned from its agent name and spawn brief and names the rule that found them (`name`, `name-over-brief`, `brief-anchor`, `brief-paragraph` or `none`). Also export `orientationEnd(brief)`, the offset where an agent-chat orientation block ends and the assignment starts, and `ORIENTATION_HEADER`. Pure functions, no I/O; existing exports are unchanged (TP-407).
