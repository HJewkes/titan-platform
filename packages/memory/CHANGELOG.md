# @titan-design/memory

## 0.1.4

### Patch Changes

- Updated dependencies [5fe09ab]
- Updated dependencies [1f7de27]
  - @titan-design/retrieval@0.3.1
  - @titan-design/store-sqlite@0.4.0

## 0.1.3

### Patch Changes

- 87e5857: `curate` now counts at most one `helpful` and one `harmful` vote per bullet per batch, whatever the `reason`, and an `add` that folds into an existing bullet counts as that bullet's `helpful` vote. Extra votes land in `report.skipped`.
- Updated dependencies [ea96b66]
- Updated dependencies [f886302]
  - @titan-design/store-sqlite@0.3.3

## 0.1.2

### Patch Changes

- Updated dependencies [e204012]
- Updated dependencies [3fea2d3]
- Updated dependencies [3e6a4af]
- Updated dependencies [3fea2d3]
  - @titan-design/store-sqlite@0.3.0
  - @titan-design/embed@0.2.0
  - @titan-design/retrieval@0.3.0

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
