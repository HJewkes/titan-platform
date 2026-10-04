---
"@titan-design/session-graph": minor
---

Migration 9 stops storing bulk classes. A graph no longer has an `artifact` table, and the `normalized_*` tables exist only when `openSessionGraph` is given `normalized: true` (they are dropped only while empty, so a graph that holds rows keeps them). This changes the default: callers that read or write the Codex path must pass `normalized: true`. `resetIndex` clears only the tables that exist, `markMissing` no longer reads `normalized_source` when it is absent, and `refreshCorpus` accepts `present` source keys that count as existing without being visited. Adds `session_state`, `ensureNormalizedSchema` and `derivedTables`.
