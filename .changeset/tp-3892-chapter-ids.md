---
"@titan-design/corpus-query": patch
---

Archive chapter ids keep their zero-padding, so `chapter_01` and `chapter_1` index as separate chapters instead of failing on the UNIQUE constraint. Ids of padded paths change (`series/1/1` becomes `series/01/01`); re-index with a fresh database.
