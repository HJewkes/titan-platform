---
"@titan-design/session-graph": minor
---

Store and project the task a spawn record assigned. `ResolvedOrigin` gains optional `taskIds` and `taskSource` (typed `TaskLinkSource`). Migration 7, `origin task link` (exported as `ORIGIN_TASK_LINK_MIGRATION_NAME`), adds the matching `session_origin` columns and changes no existing row. `sessionsNeedingOrigin` now also offers a row whose `task_source` is null. A resolver that sets `taskIds` always stores a source, or `none` (`NO_TASK_LINK`) when it found no id, so the row is not offered again. The origin upsert now updates only the columns it names instead of replacing the row. Each linked id projects a `task` row and a `ran` edge with `attrs.via = "origin"`; a re-resolution that drops an id expires only that origin-made edge. A transcript that asserts a `ran` edge the origin made first supersedes it without `via`, so origin expiry never removes a transcript's claim.
