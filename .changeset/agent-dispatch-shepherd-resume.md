---
"@titan-design/agent-dispatch": minor
---

Add `resumeAgent` over `agent-chat agent resume <name> --message`, `DispatchRequest.configDir` (passed as `--config-dir`), `dataFence` for untrusted text, and `BrokerUnavailableError` for an unreachable broker. Every agent-chat call now sets `AGENT_CHAT_NO_AUTOSTART=1`.
