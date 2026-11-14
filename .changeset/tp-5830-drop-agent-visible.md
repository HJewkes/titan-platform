---
"@titan-design/active-work": minor
"@titan-design/factory": patch
---

Stop emitting `agent_visible` from `inventory` and `task.keys` (TP-5830). Every reader now takes the `withheld_from_agents` verdict, and `task.keys` rows carry it; the shepherd's task-ref reads a missing verdict as withheld.
