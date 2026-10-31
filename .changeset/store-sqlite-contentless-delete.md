---
"@titan-design/store-sqlite": minor
---

`SpanFtsTables` and `spanFtsTablesDdl` take `contentlessDelete`, which creates the FTS table with `contentless_delete=1` so purges remove FTS rows instead of stranding them. It needs SQLite 3.43 or later and throws a clear error on an older build. `purgeOwner` deletes FTS rows when the option is on, and the new `purgeSource(sourceId)` removes every span of one source. Default tables behave exactly as before.
