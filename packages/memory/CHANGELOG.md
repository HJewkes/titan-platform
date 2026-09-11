# @titan-design/memory

## 0.1.1

### Patch Changes

- Updated dependencies [8153dd8]
- Updated dependencies [8153dd8]
  - @titan-design/retrieval@0.2.0
  - @titan-design/store-sqlite@0.2.0

## 0.1.0

### Minor Changes

- fed3a0c: New package: a decaying rule playbook on the store kit. Bullets as interval entities with
  `supersedes` edges, an append-only feedback log scored with cass-memory's decay and maturity
  math, a deterministic curator (dedup, blocked patterns, replace/merge, anti-pattern inversion,
  promotion/demotion), keyword-plus-vector recall with explicit degradation, cache_blob-backed
  embeddings, and a validated multi-iteration reflect loop with curator-stamped provenance.
