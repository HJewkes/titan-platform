---
"@titan-design/active-work": minor
---

`note list` takes `--limit` and `--cursor` to page the newest-first list. The result now reports `total`, `truncated` and `next_cursor` (null on the last page); a malformed or out-of-range cursor is a usage error. Without `--limit` the full list is returned.
