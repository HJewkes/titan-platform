---
'@titan-design/active-work': patch
---

Split session-index/origin-agent-chat.ts (events.db readers move to origin-agent-chat-read.ts) and refresh.ts (the cross-process lock moves to refresh-lock.ts). No behaviour change.
