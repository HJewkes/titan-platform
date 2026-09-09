---
"@titan-design/workflow": minor
---

Port brain's durable workflow runtime: memoized `dispatch` / `seed` / `assisted` steps over a
SQLite run table, replay-on-restart via `hydrate`, human gates through `@titan-design/hitl`,
an `agentRunner` over `@titan-design/agent`, signal parsing, and typed lifecycle events.
