# retrieval

**Tier 1 · engines.** Depends on [`store-sqlite`](/reference/store-sqlite) and
[`embed`](/reference/embed). `@huggingface/transformers` is an optional peer, needed only for
the cross-encoder reranker.

```sh
npm install @titan-design/retrieval
```

## The problem it solves

Hybrid search is easy to write and hard to keep up. Full-text finds exact terms, vectors
find paraphrases, the graph finds neighbours — and any one of them can be down, locked, or
missing a model. A naive implementation throws, and your search feature is gone.

Run several retrievers in parallel, fuse their rankings with reciprocal rank fusion,
optionally rerank, and **report which sources were unavailable rather than throwing**.

## When to reach for it

You have a corpus in `store-sqlite` and you want search over it that survives a missing
embedder. Or you want just `fuseByRRF` or `gatherFailOpen` over retrievers of your own.

## Example

Verified against 0.1.0.

```ts
import {
  BruteForceVectorIndex,
  createRetrievalEngine,
  ftsRetriever,
  graphRetriever,
  vectorRetriever,
} from "@titan-design/retrieval";

const fts = ftsRetriever(spans);   // a store-sqlite SpanFtsTables

const engine = createRetrievalEngine({
  retrievers: [fts, vectorRetriever(embedder, index), graphRetriever(edges, fts)],
  fusion: { k: 60, weights: { vector: 0.7, fts: 0.3 } },
  timeoutMs: 2_000,
});

const { results, degraded } = await engine.search("why does the daemon 503 at startup", { limit: 5 });
// results: [{ id: 'note:pid', score: 0.0275, sources: ['vector', 'graph'], payloads: {…} }, …]
// degraded: []
```

Fail-open, with a retriever that throws:

```ts
const broken = { name: "vector", retrieve: async () => { throw new Error("index locked"); } };
const engine = createRetrievalEngine({ retrievers: [fts, broken] });

const { results, degraded } = await engine.search("daemon 503", { limit: 3 });
// degraded: [{ retriever: 'vector', reason: 'error', message: 'index locked' }]
// results:  still populated from fts
```

A missing embedder or a locked index lowers recall. It never breaks search.

## The retrievers

A `Retriever` is `{ name, retrieve(query, { limit, signal }) }` returning ranked `Hit`s.
Three ship, and your own object satisfying that shape is a first-class citizen.

- **`ftsRetriever(spans)`** — BM25 over a contentless FTS5 span index. Spans collapse to
  their owner's best rank, and the winning span's locator travels in the payload. Query text
  is tokenised and quoted, so punctuation cannot break FTS5 syntax:
  `defaultMatchExpression("fix: the (broken) build!")` is `"fix" OR "the" OR "broken" OR "build"`.
- **`vectorRetriever(embedder, index)`** — embeds the query (with `search_query: ` for nomic
  models) and asks a `VectorIndex`. `BruteForceVectorIndex` is an exact in-memory cosine
  scan; implement the same interface over sqlite-vec when the corpus outgrows it.
- **`graphRetriever(edges, seededBy)`** — takes another retriever's top results as seeds and
  walks the edge table by hop, optionally restricted to relations or to outbound direction.
  `expandGraph` is the walk on its own.

## Fusion

`fuseByRRF` scores each id as the sum over lists of `weight / (k + rank)`, `k` defaulting to
60. An id that several retrievers agree on outranks one that tops a single list. `minScore`
and `dropoff` (cut at the largest relative score drop) trim the fused list.

Scores are small by construction — an id ranked first by one unweighted retriever scores
`1/61 ≈ 0.0164`. Do not read them as probabilities; only the order and the relative gaps
mean anything.

## Reranking

`crossEncoderReranker()` runs `Xenova/ms-marco-MiniLM-L-6-v2` in-process through
`@huggingface/transformers`, loaded on first use. Any object with `score(query, texts)`
works. The engine needs `textFor(result)` to know what text to show the reranker, because
results are ids plus locators and never stored text.

## Gotchas

**A graph-only hit has no locator.** It was reached by expansion, not by matching text. Do
not fabricate an excerpt for it; the session miner returns `excerpt: null`.

**`timeoutMs` is a per-retriever deadline**, not a budget for the whole search. Each
retriever gets its own `AbortController`; one that exceeds the deadline lands in `degraded`
with `reason: "timeout"` while the others finish normally. `timingsMs` on the gather result
reports what each one actually took.

## Where it came from

brain's `search.ts` (RRF K=60, rerank), extracted with the note-specific stages left behind
and fail-open added.
