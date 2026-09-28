---
"@titan-design/session-graph": minor
---

Store and project the task a spawn record assigned. `ResolvedOrigin` gains optional `taskIds` and `taskSource`; migration 7, `origin task link` (exported as `ORIGIN_TASK_LINK_MIGRATION_NAME`), adds the matching `session_origin` columns and re-queues every existing origin row once. Each linked id projects a `task` row and a `ran` edge with `attrs.via = "origin"`; a re-resolution that drops an id expires only that origin-made edge, never a transcript's.
