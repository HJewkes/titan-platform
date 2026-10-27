---
"@titan-design/active-work": patch
---

`miner rebuild` now holds a lock on `graph.sqlite3.next` for the whole rebuild, so two rebuilds (two `--resume` runs included) can no longer build into the same file; the second is refused.
