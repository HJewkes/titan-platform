---
"@titan-design/agent-dispatch": minor
---

Add `lastFencedJson(text)`, which parses the last ```` ```json ```` block of an agent's final message, and optional `role` and `task` on a spawn, sent as agent-chat's `--role` and `--task` so the roster row records the agent's role and task. A task id outside `TASK_ID_PATTERN` is refused before the spawn.
