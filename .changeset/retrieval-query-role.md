---
"@titan-design/retrieval": minor
---

`vectorRetriever` no longer prepends `search_query: ` to nomic queries (TP-168). It calls `embedder.embed([query], { role: "query" })` and leaves prefixes to the embedder. Before, the embedder added its own `search_document: ` on top, so a default nomic query was embedded as `search_document: search_query: <q>`.

- **Rankings change** for every nomic-backed vector retriever: query vectors now sit in the query region of nomic's space. Hash and other unprefixed embedders are unaffected.
- **Breaking:** the `queryPrefix` option is removed. Configure the embedder's `prefixes` instead.
- Needs `@titan-design/embed` 0.2 or later. A 0.1 embedder ignores the role and embeds the query as `search_document: <q>`. active-work pins 0.2.0 exactly and keeps the old behaviour until it upgrades both packages together.
