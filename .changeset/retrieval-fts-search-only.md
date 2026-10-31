---
"@titan-design/retrieval": patch
---

`ftsRetriever` now needs only the `search` method of a span table, so a caller can pass a reader that picks its table per query.
