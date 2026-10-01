---
"@titan-design/code-graph": patch
---

The ts-morph extractor without a tsconfig now loads automatic `@types` from the indexed repo's `node_modules/@types` chain instead of from `process.cwd()`. Inferred signatures no longer depend on where the indexer runs, and indexing a tree outside the caller's workspace no longer parses the caller's `@types` (the cause of the slow incremental-index tests, TP-442).
