# @titan-design/embed

## 0.2.0

### Minor Changes

- 3fea2d3: Fix the double prefix on nomic queries (TP-168): the embedder now owns task prefixes per role, and `model` names the vector space including those prefixes.

  - `embed(texts, { role: "document" | "query" })`. A role-less call is a document, as before. `OllamaEmbedder` and `LocalEmbedder` apply `search_document: ` / `search_query: ` for any model whose name contains `nomic`, and no prefix for every other model. Override per role with the new `prefixes` option.
  - **Breaking:** `OllamaEmbedder`'s `prefix` option is removed; use `prefixes: { document, query }`.
  - **Breaking:** `model` on `OllamaEmbedder` and `LocalEmbedder` is now `<name>#p=<8 hex>`, a hash of the prefix table, and `modelName` holds the raw name. `HashEmbedder` keeps `hash-v1-<dims>`. Caches keyed on `model` (store-sqlite's `blob_cache` as code-graph and memory use it) do not reuse 0.1 entries: they are orphaned and re-embedded, never served for the new space.
  - **Vectors change** for nomic queries once `@titan-design/retrieval` 0.3 passes the query role, and for documents embedded through `OllamaEmbedder` with a non-nomic model, which 0.1 wrongly prefixed with `search_document: `. Default nomic document vectors are unchanged.
  - New exports: `EmbedRole`, `EmbedOptions`, `RolePrefixes`, `NOMIC_PREFIXES`, `NO_PREFIXES`, `defaultPrefixesFor`, `vectorSpaceId`.

## 0.1.0

### Minor Changes

- c9a2dd2: Extract the embedder layer from brain: the `Embedder` interface, an Ollama embedder over
  plain fetch (local and remote collapse into one class), an in-process `LocalEmbedder` with
  `@huggingface/transformers` as an optional peer, a new zero-download `HashEmbedder` fallback,
  `createEmbedder` with probe-and-fall-back, and float32 vector helpers.
