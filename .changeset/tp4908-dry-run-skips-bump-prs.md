---
"@titan-design/factory": patch
---

`titan-factory release bump-consumers --dry-run` now runs the sweep's open and closed bump PR checks, read only, and prints `skip <repo>: open bump PR #N` or `closed bump PR #N` instead of listing a repo the real run would leave alone.
