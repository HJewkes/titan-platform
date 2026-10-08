---
"@titan-design/session-miner": patch
---

Read agent-chat's events.db through session-analytics' `readVerdicts`, `readSpawns` and `readLastPrompts` and delete the miner's copies of those queries. The miner still checks the file exists, naming `TITAN_MINER_EVENTS_DB` with a data error, and opens it read-only; liveness now opens it once for both reads. Test fixtures create the events table from `EVENTS_TABLE_DDL` instead of a copy of agent-chat's schema.
