---
"titan-console": patch
---

Resolve the default `agent-chat` binary on PATH at config load, so seats are told when their rounds are answered. When it is not found, seat notices are off and `serve` prints one warning naming `TITAN_CONSOLE_AGENT_CHAT_BIN`.
