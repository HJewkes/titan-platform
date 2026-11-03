---
"@titan-design/agent-dispatch": minor
---

`retire` takes a `caller` option (TP-3622). It is checked against `PEER_NAME_PATTERN` and sent to the agent-chat CLI as `AGENT_CHAT_NAME`, the only addition to the minimal env, so the broker's `agent_retired` event names that caller instead of `human`. `RetireOptions` is exported.
