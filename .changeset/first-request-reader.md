---
"@titan-design/session-read": minor
---

`readFirstRequest(path)` rebuilds the first API request a Claude Code transcript recorded: tools, system and message blocks in API order (messages in the request's `tail` order, not file order), the cache breakpoints it carried, the model, agent name and the usage of its response.
