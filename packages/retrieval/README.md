# @titan-design/retrieval

Hybrid retrieval that degrades instead of failing: run several retrievers in parallel,
fuse their rankings with reciprocal rank fusion, optionally rerank with a cross-encoder,
and report which sources were unavailable rather than throwing.

Tier 1 of the titan-platform DAG. Depends on `@titan-design/store-sqlite` and
`@titan-design/embed`. Extracted from brain's `search.ts` (TP-8) with the note-specific
stages left behind and fail-open added.

```ts
import { createRetrievalEngine, ftsRetriever, vectorRetriever, graphRetriever } from "@titan-design/retrieval";

const fts = ftsRetriever(spans);                 // store-sqlite SpanFtsTables
const engine = createRetrievalEngine({
  retrievers: [fts, vectorRetriever(embedder, index), graphRetriever(edges, fts)],
  fusion: { k: 60, weights: { vector: 0.7, fts: 0.3 } },
  timeoutMs: 2_000,
});

const { results, degraded } = await engine.search("why does the daemon 503 at startup", { limit: 10 });
```

## Retrievers

A `Retriever` is `{ name, retrieve(query, { limit, signal }) }` returning ranked `Hit`s.
Three ship:

- `ftsRetriever(spans)`: BM25 over a contentless FTS5 span index. Spans collapse to their
  owner's best rank, and the winning span's locator travels in the payload. Query text is
  tokenized and quoted so punctuation cannot break FTS5 syntax.
- `vectorRetriever(embedder, index)`: embeds the query (with `search_query: ` for nomic
  models) and asks a `VectorIndex`. `BruteForceVectorIndex` is an exact in-memory cosine
  scan; implement the same interface over sqlite-vec when the corpus outgrows it.
- `graphRetriever(edges, seededBy)`: takes another retriever's top results as seeds and
  walks the edge table by hop, optionally restricted to relations or outbound direction.
  `expandGraph` is the walk on its own.

## Fusion and fail-open

`fuseByRRF` scores each id as the sum over lists of `weight / (k + rank)`, so an id that
several retrievers agree on outranks one that tops a single list. `k` defaults to 60.

`gatherFailOpen` runs retrievers concurrently. One that throws, or exceeds `timeoutMs`,
contributes nothing and appears in `degraded` with the reason. A missing embedder or a
locked index lowers recall; it never breaks search.

`minScore` and `dropoff` (cut at the largest relative score drop) trim the fused list.

## Reranking

`crossEncoderReranker()` runs `Xenova/ms-marco-MiniLM-L-6-v2` in-process through
`@huggingface/transformers`, an optional peer dependency loaded on first use. Any object
with `score(query, texts)` works. The engine needs `textFor(result)` to know what text to
show the reranker, since results are ids plus locators, never stored text.
