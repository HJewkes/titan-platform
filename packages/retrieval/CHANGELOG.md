# @titan-design/retrieval

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
