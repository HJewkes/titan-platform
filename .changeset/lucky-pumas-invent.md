---
"@titan-design/session-graph": patch
---

Purge a rewritten transcript's derived rows before re-reading it from byte 0, and restore
a `missing` transcript to `ok` when its file comes back.

A rewind previously left the old rows in place: `session.turn_count`, the
`session_model_usage` token buckets and the commit/push counts summed onto what was
already there, and facts the rewrite removed persisted on their unique index. Separately,
a transcript that vanished and returned unchanged took the `unchanged` fast path, so
`advance()` — the only writer of status `ok` — never ran and the row stayed `missing`
forever. Quarantined rows are deliberately still not cleared.
