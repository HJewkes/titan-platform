---
"@titan-design/retrieval": patch
---

Make the rerank stage fail open. A cross-encoder (or a `textFor`) that throws now leaves
the RRF-fused ranking in place and reports itself in the same `degraded` array the
retrievers use, instead of failing the whole search.
