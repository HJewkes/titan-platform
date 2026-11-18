---
"@titan-design/store-sqlite": minor
"@titan-design/code-graph": minor
---

`CacheBlobTable` gains `delete(namespace, model)`, which drops every row under that pair and returns the count, and `models(namespace)`, which lists the models holding rows there with their row counts (TP-220). code-graph's `embedSnapshot` result now carries `staleVectors`, the symbol vectors cached under another model identity, and the new `pruneStaleSymbolVectors(store, model)` deletes them, returning `{ deleted, models }`. `embedSnapshot` does not prune on its own.
