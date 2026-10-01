---
"@titan-design/session-graph": minor
"@titan-design/session-miner": patch
---

`openSessionGraph(path, { readonly: true })` opens a graph another process owns without migrating it, and throws `SessionGraphNotMigratedError` when it lacks a session-graph migration. The session miner reads such a graph with `--graph <file>` (`TITAN_MINER_GRAPH`), and its own migrations move from 1000-1002 to 2000-2002 so they no longer collide with active-work's band at 1001. A miner database migrated at the old numbers re-applies the new ones idempotently.
