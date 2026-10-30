---
"@titan-design/agent-dispatch": minor
---

Add `sqliteHost` to `@titan-design/agent-dispatch/host`: the same ports as `memoryHost`, with the journal kept in SQLite through `@titan-design/store-sqlite` so a reopened database folds the same rows in append order.
