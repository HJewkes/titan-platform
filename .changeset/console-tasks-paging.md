---
"titan-console": minor
---

Page `work.tasks` on a cursor. A read answers at most `limit` rows (default 50, at most 200) in priority order with a `nextCursor` to the rest, in place of the 200-per-stage cap and its `perStage` argument; `counts` still covers every match. The Tasks page shows a skeleton while its first page loads and adds later pages with Load more.
