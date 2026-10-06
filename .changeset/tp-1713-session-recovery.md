---
"@titan-design/session-read": minor
---

Add `recoverSession`, a facts-only extractor for a session that ended with no wrap. It reads one
transcript and returns the session span, the registered agent name, files written under a root,
active-work and git/gh command heads, chat_send and agent_spawn targets with first lines, the last
five owner messages and the last assistant message, all capped. No model call, network or write.
