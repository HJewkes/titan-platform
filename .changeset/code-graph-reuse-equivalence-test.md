---
"@titan-design/code-graph": patch
---

Remove an `indexer.test.ts` case that claimed to assert incremental-reuse equivalence but ran two full indexes, and point the README and reference page at `incremental-index.test.ts`, which compares full snapshots against a fresh full index.
