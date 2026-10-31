---
"@titan-design/active-work": patch
---

Rank an agent's task add related list in memory from the initiative's open tasks instead of the SQLite index, so the read costs milliseconds, never blocks the daemon on FTS, and its deadline is hard.
