---
"@titan-design/active-work": patch
---

Port three standalone fixes: `aw --profile <name>` picks the Claude account, `task add` skips a task file that does not validate and keeps its id, and reopening a task clears `done_at`.
