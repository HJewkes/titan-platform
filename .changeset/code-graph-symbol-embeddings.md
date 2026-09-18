---
"@titan-design/code-graph": minor
---

Add codewatch's symbol embeddings and similar-symbol search, ported onto `@titan-design/embed` and `@titan-design/retrieval`: `embedSnapshot`, `tryEmbedSnapshot` (non-fatal), `findSimilarCapability`, `listEmbeddableSymbols`, `buildEmbedText`, `hashEmbedText`, `embedTextsCached`, and their result types. Vectors are content-addressed in the existing `blob_cache` table.
