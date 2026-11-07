# @titan-design/retrieval

## 0.4.0

### Minor Changes

- 42b6a21: Add `walkGraph({ neighbours, degree, degrees? }, seeds, { hops, hubDegree, maxNodes })`, a breadth-first walk over any adjacency that returns a hub (a non-seed node with degree at least `hubDegree`) but never expands it, so one busy node cannot flood the result. `hubDegree` defaults to `defaultHubDegree(degrees)`, max(50, p99 degree), also exported. `expandGraph` is now the edge-table adapter over it and gains optional `hubDegree` and `maxNodes`; without them its output is unchanged. The hub cap is adapted from graphify under Apache-2.0, and the package now ships a `NOTICE`.

### Patch Changes

- 42551ba: `ftsRetriever` now needs only the `search` method of a span table, so a caller can pass a reader that picks its table per query.
- f996bb9: Narrow the optional transformers import and the test fetch stub without type assertions.
- Updated dependencies [c58d555]
- Updated dependencies [d279098]
- Updated dependencies [c1f9297]
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/embed@0.2.1

## 0.3.1

### Patch Changes

- 5fe09ab: Honour a signal that is already aborted when the search starts: every retriever now degrades with reason `error` instead of running to completion.
- Updated dependencies [1f7de27]
  - @titan-design/store-sqlite@0.4.0

## 0.3.0

### Minor Changes

- 3fea2d3: `vectorRetriever` no longer prepends `search_query: ` to nomic queries (TP-168). It calls `embedder.embed([query], { role: "query" })` and leaves prefixes to the embedder. Before, the embedder added its own `search_document: ` on top, so a default nomic query was embedded as `search_document: search_query: <q>`.

  - **Rankings change** for every nomic-backed vector retriever: query vectors now sit in the query region of nomic's space. Hash and other unprefixed embedders are unaffected.
  - **Breaking:** the `queryPrefix` option is removed. Configure the embedder's `prefixes` instead.
  - Needs `@titan-design/embed` 0.2 or later. A 0.1 embedder ignores the role and embeds the query as `search_document: <q>`. active-work pins 0.2.0 exactly and keeps the old behaviour until it upgrades both packages together.

### Patch Changes

- 3e6a4af: Make the rerank stage fail open. A cross-encoder (or a `textFor`) that throws now leaves
  the RRF-fused ranking in place and reports itself in the same `degraded` array the
  retrievers use, instead of failing the whole search.
- Updated dependencies [e204012]
- Updated dependencies [3fea2d3]
  - @titan-design/store-sqlite@0.3.0
  - @titan-design/embed@0.2.0

## 0.2.0

### Minor Changes

- 8153dd8: `ftsRetriever` accepts `scope` and `cap`, which together make the five-class retrieval
  shape expressible without a product writing its own SQL.

  `scope` restricts a retriever to one class of owner, so it becomes one ranked list among
  several rather than the whole index. RRF computes rank within a list, so a class of 92,713
  spans cannot swamp a class of 1,569 — it only ever contributes its own top-N. This is the
  decision that does most of the work; a pooled retriever over the same tables returns the
  large class and nothing else.

  `cap` is a hard ceiling on hits from one retriever, whatever the engine overfetches. The
  engine's overfetch is uniform, which is the wrong shape for a class prior: some classes are
  duplicate content of others and should contribute a handful of candidates at most. It
  composes with `fusion.weights` rather than replacing it — the weight sets how much a hit
  counts, the cap sets how many there are.

  Both default to absent, so existing retrievers are unchanged.

### Patch Changes

- Updated dependencies [8153dd8]
  - @titan-design/store-sqlite@0.2.0

## 0.1.0

### Minor Changes

- 6cea9aa: Extract the retrieval engine from brain's search pipeline: RRF fusion (k = 60), FTS, vector,
  and graph retrievers over the store kit, a fail-open gatherer that reports degraded sources
  instead of throwing, dropoff and min-score filters, and an optional cross-encoder reranker.

### Patch Changes

- Updated dependencies [c9a2dd2]
- Updated dependencies [aa5f694]
  - @titan-design/embed@0.1.0
  - @titan-design/store-sqlite@0.1.0
