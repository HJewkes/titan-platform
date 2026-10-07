---
"@titan-design/session-graph": patch
---

`indexCodexSource` now quarantines a source only for bad file contents (a parse error or a `SessionIdentityError`) and rethrows store and programming errors, matching the Claude path, so a SQLite failure during the swap no longer records the source as quarantined.
