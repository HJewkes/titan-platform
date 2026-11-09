---
"@titan-design/factory": patch
---

`readEvents` now throws on a limit that is not a positive integer. SQLite read a negative `LIMIT` as unbounded and `0` as empty, so `limit: -1` returned the whole table.
