---
"@titan-design/active-work": minor
---

`task add` now refuses an agent caller (the MCP surface, or a CLI run with `AGENT_CHAT_NAME` or `CLAUDECODE` set) whose `done_when` is missing, blank, equal to the title, or under 40 characters. The refusal is a one-line `ValidationError` (exit 65) naming the minimum, raised before the lock so no id is burned. Human CLI callers and `/rpc` are unchanged.
