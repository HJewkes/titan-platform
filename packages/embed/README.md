# @titan-design/embed

Text embeddings behind one small interface, with a fallback that needs no model at all.

Tier 0 of the titan-platform DAG. No required dependencies. Extracted from brain's
`src/adapters/` (TP-8).

```ts
import { createEmbedder } from "@titan-design/embed";

const embedder = await createEmbedder({ backend: "ollama" }, { fallbackToHash: true });
const [vector] = await embedder.embed(["what does the daemon watch?"]);
// embedder.model tells you which vector space you are in
```

## Backends

- **`ollama`**: `OllamaEmbedder` posts to Ollama's `/api/embed` over plain fetch. A remote
  Ollama is the same class with a different `url`. Default model `nomic-embed-text`
  (768 dims) with the `search_document: ` prefix it expects; both configurable.
- **`local`**: `LocalEmbedder` runs ONNX weights in-process through
  `@huggingface/transformers`, which is an optional peer dependency. Default
  `Xenova/bge-small-en-v1.5` (384 dims, q8). If the runtime is not installed the first
  `embed` call fails with a message saying so.
- **`hash`**: `HashEmbedder` feature-hashes word unigrams and bigrams into a fixed width
  (256 by default), sign-hashed and L2-normalized. It is lexical, not semantic, but it is
  deterministic, instant, and always available.

## Fallback is a startup decision

`createEmbedder(config, { fallbackToHash: true })` probes the backend once and returns a
`HashEmbedder` if the probe fails or returns the wrong width. It never switches per call:
vectors from two models must not share an index, and the returned embedder's `model` is
the key you store them under.

## Vector helpers

`cosineSimilarity`, `dot`, `norm`, `normalize`, and `toFloat32Buffer` /
`fromFloat32Buffer` for storing vectors as little-endian float32 bytes in a cache blob or
a sqlite-vec column.
