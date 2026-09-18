# @titan-design/embed

Text embeddings behind one small interface, with a fallback that needs no model at all.

Tier 0 of the titan-platform DAG. No required dependencies. Extracted from brain's
`src/adapters/` (TP-8).

```ts
import { createEmbedder } from "@titan-design/embed";

const embedder = await createEmbedder({ backend: "ollama" }, { fallbackToHash: true });
const docs = await embedder.embed(["the daemon watches the state directory"]); // role "document"
const [query] = await embedder.embed(["what does the daemon watch?"], { role: "query" });
// embedder.model tells you which vector space you are in
```

## Backends

- **`ollama`**: `OllamaEmbedder` posts to Ollama's `/api/embed` over plain fetch. A remote
  Ollama is the same class with a different `url`. Default model `nomic-embed-text`
  (768 dims).
- **`local`**: `LocalEmbedder` runs ONNX weights in-process through
  `@huggingface/transformers`, which is an optional peer dependency. Default
  `Xenova/bge-small-en-v1.5` (384 dims, q8). If the runtime is not installed the first
  `embed` call fails with a message saying so.
- **`hash`**: `HashEmbedder` feature-hashes word unigrams and bigrams into a fixed width
  (256 by default), sign-hashed and L2-normalized. It is lexical, not semantic, but it is
  deterministic, instant, and always available. It ignores the role.

## Roles and prefixes

`embed(texts, { role })` takes `"document"` (the default) or `"query"`. The embedder, and
only the embedder, turns the role into model-specific text, so a caller never prepends a
prefix itself. Models trained with task prefixes expect exactly one per text.

| Model | `document` | `query` |
| --- | --- | --- |
| any name containing `nomic` (Ollama or local) | `search_document: ` | `search_query: ` |
| everything else, including `bge-small-en-v1.5` | none | none |

Override either role with `prefixes`, for example `new OllamaEmbedder({ prefixes: { document:
"", query: "" } })` for no prefix at all, or `new LocalEmbedder({ prefixes: { query:
"Represent this sentence for searching relevant passages: " } })` for bge's optional query
instruction. A third-party `Embedder` whose `embed` ignores the second argument still
satisfies the interface, but then it embeds queries exactly like documents.

## Vector-space identity

`embedder.model` names the vector space, not just the model. For `ollama` and `local` it is
the model name plus a short hash of the prefix table, for example `nomic-embed-text#p=…`;
`modelName` keeps the raw name. Two prefix configurations of one model therefore never share
a cache key. The hash embedder has no prefixes and keeps `hash-v1-<dims>`.

Keys written by 0.1 used the bare model name, which never matches a 0.2 identity, so those
cache entries are orphaned and re-embedded rather than served. That is deliberate: a 0.1 key
does not record which prefix made its vector.

## Fallback is a startup decision

`createEmbedder(config, { fallbackToHash: true })` probes the backend once and returns a
`HashEmbedder` if the probe fails or returns the wrong width. It never switches per call:
vectors from two spaces must not share an index, and the returned embedder's `model` is
the key you store them under.

## Vector helpers

`cosineSimilarity`, `dot`, `norm`, `normalize`, and `toFloat32Buffer` /
`fromFloat32Buffer` for storing vectors as little-endian float32 bytes in a cache blob or
a sqlite-vec column.
