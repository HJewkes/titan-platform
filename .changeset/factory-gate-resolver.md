---
"@titan-design/factory": minor
---

The factory host runs `gateResolverMigration(7)`, so every resolved gate records who resolved it. `titan-factory gate resolve` passes the owner at a terminal (`owner-terminal`, the OS user, channel `factory-cli`), or `coordinator` when `AGENT_CHAT_AGENT_ID` is set, which hitl refuses: the command exits 1 and the gate stays pending. `SHEPHERD_MIGRATIONS` names the shepherd tenant's versions 4 to 6.
