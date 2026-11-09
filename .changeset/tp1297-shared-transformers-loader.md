---
"@titan-design/embed": patch
"@titan-design/retrieval": patch
---

Embed exports `loadTransformersPipeline(missingMessage)`, the one place that imports the optional `@huggingface/transformers` peer. `LocalEmbedder` and the retrieval cross-encoder reranker both load through it and keep their own missing-runtime messages.
