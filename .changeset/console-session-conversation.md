---
'titan-console': patch
---

Render the session Conversation tab with react-ui's `SessionConversation` in place of the local stand-in: messages now always show, and each turn's tool calls sit in a group that starts open for the first or deep-linked turn (TP-6344).
