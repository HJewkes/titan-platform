---
"@titan-design/session-graph": patch
---

`indexCodexSource` now quarantines a source only for decoder or parse errors and rethrows store and programming errors, matching the Claude path, so a SQLite failure during the swap no longer records the source as quarantined.
