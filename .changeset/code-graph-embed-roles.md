---
"@titan-design/code-graph": patch
---

Symbol embeddings pass `role: "document"` for symbol texts and let the retriever pass `role: "query"`, so a default nomic query carries one prefix, not two (TP-168). `FindSimilarOptions.queryPrefix` is removed before its first release; configure the embedder's `prefixes` instead. The `blob_cache` model column now holds embed 0.2's prefix-aware `embedder.model`, so vectors cached under the bare model name are re-embedded, not reused, and `findSimilarCapability` scores for nomic change.
