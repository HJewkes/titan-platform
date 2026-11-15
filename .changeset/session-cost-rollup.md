---
"@titan-design/session-graph": minor
---

Materialize per-session cost in a `session_cost` table (migration 18). `rollupSessions` rewrites the rows for the sessions it rolls up from their request rows, and replacing the price table re-derives every row.
