---
"@titan-design/session-graph": patch
---

Correct the docs that called the schema safe to drop and re-derive: migrations must preserve `fact` and `session` rows, and several tables are not derived from transcripts.
