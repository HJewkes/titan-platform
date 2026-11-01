---
"@titan-design/factory": minor
---

The factory's spawn limits now layer `limits.shepherd` from `$AGENT_CHAT_HOME/config.json` (spawn gate `load5` and `build_load5`, review `max_concurrent`) over the factory config values. An absent block keeps the factory values; a malformed one keeps them and logs the fallback once.
