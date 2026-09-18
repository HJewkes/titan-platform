# embed

**Tier 0 · primitives.** No required dependencies. `@huggingface/transformers` is an
optional peer.

```sh
npm install @titan-design/embed
```

## The problem it solves

Every semantic feature wants embeddings, and every embedding backend is a different reason
for your tool to fail at startup: a model that has not downloaded, an Ollama that is not
running, an API key that is not set.

This puts three backends behind one small interface and adds a fallback that needs no model
at all, so a semantic feature can degrade to a lexical one instead of erroring.

## When to reach for it

You want vectors and you are not willing to make a model download a hard install
requirement. Pair it with [`retrieval`](/reference/retrieval), which consumes the same
`Embedder` interface.

## Example

Verified against 0.2.0 with a local Ollama running.

```ts
import { cosineSimilarity, createEmbedder } from "@titan-design/embed";

const embedder = await createEmbedder({ backend: "ollama" }, { fallbackToHash: true });

const [a, b] = await embedder.embed([
  "the daemon watches the state directory",
  "the daemon watches state",
]);                                            // role "document" by default
const [q] = await embedder.embed(["what does the daemon watch?"], { role: "query" });

embedder.model;             // 'nomic-embed-text#p=86c004a5'  (or 'hash-v1-256' if the probe failed)
embedder.modelName;         // 'nomic-embed-text'
a.length;                   // 768
cosineSimilarity(a, b);     // 0.913
cosineSimilarity(q, a);     // 0.803
```

With no Ollama and no transformers runtime installed, the same call returns a
`HashEmbedder`, `embedder.model` is `hash-v1-256`, and every downstream call still works — with lexical rather than semantic similarity.

## The backends

- **`ollama`** — `OllamaEmbedder` posts to `/api/embed` over plain fetch. A remote Ollama is
  the same class with a different `url`. Default model `nomic-embed-text` (768 dims).
- **`local`** — `LocalEmbedder` runs ONNX weights in-process through
  `@huggingface/transformers`. Default `Xenova/bge-small-en-v1.5` (384 dims, q8). If the
  runtime is not installed, the first `embed` call fails with a message saying so.
- **`hash`** — `HashEmbedder` feature-hashes word unigrams and bigrams into a fixed width
  (256 by default), sign-hashed and L2-normalised. Lexical, not semantic, but deterministic,
  instant, and always available. It ignores the role.

## Roles and prefixes

`embed(texts, { role })` takes `"document"` (the default) or `"query"`. The embedder is the
only layer that turns a role into model-specific text; callers, including
[`retrieval`](/reference/retrieval)'s `vectorRetriever`, never prepend a prefix themselves.
Models trained with task prefixes expect exactly one per text.

| Model | `document` | `query` |
| --- | --- | --- |
| any name containing `nomic` (Ollama or local) | `search_document: ` | `search_query: ` |
| everything else, including `bge-small-en-v1.5` | none | none |

Override either role with `prefixes`: `new OllamaEmbedder({ prefixes: { document: "", query:
"" } })` sends no prefix at all, and `new LocalEmbedder({ prefixes: { query: "Represent this
sentence for searching relevant passages: " } })` adds bge's optional query instruction.

## Gotchas

**The fallback is a startup decision, not a per-call one.** `createEmbedder(config, {
fallbackToHash: true })` probes the backend once and returns a `HashEmbedder` if the probe
fails or returns the wrong width. It never switches mid-run: vectors from two models must
not share an index.

**`embedder.model` is the key you store vectors under.** Treat it as part of the index
identity. Mixing a hash-fallback run into an index built with nomic silently poisons it.
For `ollama` and `local` it is the model name plus a hash of the prefix table
(`nomic-embed-text#p=86c004a5`), so two prefix configurations never share a key;
`modelName` keeps the raw name.

**0.1 cache entries are not reused.** 0.1 keyed vectors on the bare model name, which does
not record the prefix that made them, and no 0.2 identity equals a bare name. Those entries
are orphaned and re-embedded on first use. In 0.1, `retrieval`'s `vectorRetriever` also
prepended `search_query: ` on top of the embedder's `search_document: `, so nomic queries
carried two prefixes; 0.2 fixes that, which changes nomic query vectors and rankings.

## Vector helpers

`cosineSimilarity`, `dot`, `norm`, `normalize`, and `toFloat32Buffer` / `fromFloat32Buffer`
for storing vectors as little-endian float32 bytes in a `cache_blob` row or a sqlite-vec
column.

## Where it came from

brain's `src/adapters/` (132 lines). The hash fallback was added during extraction.
