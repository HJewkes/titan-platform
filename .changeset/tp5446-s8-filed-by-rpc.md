---
"@titan-design/active-work": patch
---

A task filed over the daemon's /rpc or MCP surface records `filed_by: unknown`. Before this, it took the daemon's own `AGENT_CHAT_NAME`, or `owner` when the daemon had none (TP-5446 S8 follow-up).
