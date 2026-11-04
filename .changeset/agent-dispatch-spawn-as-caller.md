---
"@titan-design/agent-dispatch": minor
---

Add `spawnAsCaller`, an agent-chat spawn that forwards the caller's `AGENT_CHAT_NAME`, `AGENT_CHAT_AGENT_ID` and `CLAUDE_CONFIG_DIR` and returns the CLI's stdout lines. `buildSpawnArgs` takes `host`, `account`, `surface` and `remoteControl`; its argv is unchanged when they are absent.
