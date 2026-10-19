---
"@titan-design/agent-protocol": minor
"@titan-design/session-read": patch
---

Move the existing pure transcript source, observation and continuation declarations into agent-protocol/harness, preserving session-read compatibility exports and all decoder/read behavior. This is a further partial TP-3426 S01 checkpoint; account, pricing, policy and bus ports remain unfinished.
