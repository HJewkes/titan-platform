# @titan-design/code-read

## 0.2.0

### Minor Changes

- 1743211: Add the `changes.get` command (contract 0.1.5): against a required `baseline`, the files that crossed the hotspot `cutoff`, files the baseline does not hold, findings new, worsened, improved, and resolved, new co-change coupling (reported `measured: false` until pairs are stored), and regressions, files whose score rose that carry an open finding. Across index versions it returns `comparable: false` and empty lists. It reuses code-graph's `computeReportDrift` and `bucketViolations` through `@titan-design/code-graph/analysis`, so the live handler and the static resolver return the same result.
- b4f9472: Add the `hotspots.list` command (contract 0.1.3): files or symbols ranked by hotspot score over a churn window, with a caller-supplied cutoff, offset paging, and new or worsened marks against a baseline. Both grains reuse code-graph's report derivations through `@titan-design/code-graph/analysis`, so the live handler and the static resolver return the same rows.
- 689c518: Add optional `lenses` to `node.get` (contract 0.1.6, additive). `exports` lists a file's declared symbols with utilization, consumer count, and own cognitive complexity; `score` breaks the hotspot score at the node's grain into churn, complexity, recency, and utilization, with its rank, for a `window`; `centrality` gives every file in the reading order a PageRank score and a rank; `coupling` reports co-changed partners as `measured: false` until pairs are stored; `tests` lists path-linked tests beside the indexer's `linked_test_count`. A call with no lenses returns the same result as before. The reading order in `overview.get` and the centrality lens share one ranking.
- 7682bd6: Add the `overview.get` command (contract 0.1.4): KPIs, named attention signals weighted and capped by caller-supplied weights, a reading order by PageRank centrality, and the top look-first files with their reasons. An optional `combined` number is secondary to the signals. It reuses code-graph's derivations through `@titan-design/code-graph/analysis`, so the live handler and the static resolver return the same result.
- d7fa488: Add the `packages.stats` command (contract 0.1.8): code-graph's `computePartitionQuality` over a snapshot's package roots, either the `packages` given or every root the product's `layered-deps` rules declare. Per package it returns the file count, internal, outgoing, and incoming edges, cohesion, instability, abstractness, the instability band, and flags, plus its declared tier as `layer`, or `layer: { status: "undeclared" }` for a root no tier names. It also returns the package-to-package edges, the snapshot's modularity, and the count of files under no root. A `ModelRule` now carries a `layered-deps` rule's `layers`; `finding.get` still returns the rule without them. The live handler and the static resolver return the same result.
- 3a2dfcc: Add the `paths.impact` command (contract 0.1.7): given repo-relative `paths` and an optional `baseline`, each file's hotspot complexity, its score and rank as `hotspots.list` ranks it at `window`, and its open findings, plus a rollup. With a comparable baseline each row gets a score, complexity, and findings delta, findings bucketed by code-graph's `bucketViolations` as `changes.get` buckets them; without one `delta` is absent, and across index versions it is null. A path the snapshot holds no file for answers a `not-indexed` row and one outside the repo an `outside-repo` row, never an error; a leading `./` is dropped and absolute paths are read under the optional `root`. The live handler and the static resolver return the same result.

### Patch Changes

- 425a4b8: `paths.impact` counts the resolved findings of a deleted file in the rollup delta, and rejects a `root` above the index's repo root instead of reading paths against it.
- 6fd00e8: Doc comment and test only: correct the `scoredRows` comment and build the `changes.get` static side through `loadReadModel`, with a destination-keyed finding.
- Updated dependencies [b4f9472]
- Updated dependencies [689c518]
- Updated dependencies [1743211]
- Updated dependencies [445c85c]
- Updated dependencies [4722ea7]
- Updated dependencies [9327cb0]
- Updated dependencies [ab1b1c0]
- Updated dependencies [4c8013a]
- Updated dependencies [f8f49ee]
- Updated dependencies [7682bd6]
- Updated dependencies [1dc1a3b]
- Updated dependencies [3a2dfcc]
- Updated dependencies [c32abb7]
- Updated dependencies [c0420d2]
- Updated dependencies [887982d]
- Updated dependencies [d7fa488]
- Updated dependencies [c65fce1]
- Updated dependencies [326a235]
- Updated dependencies [402654f]
- Updated dependencies [bece4b2]
- Updated dependencies [1d1b6fa]
- Updated dependencies [add80d0]
- Updated dependencies [f38088f]
- Updated dependencies [2b1f4d3]
- Updated dependencies [1805bce]
- Updated dependencies [e6dd995]
- Updated dependencies [4662078]
  - @titan-design/code-graph@0.13.0

## 0.1.10

### Patch Changes

- Updated dependencies [5958e6e]
- Updated dependencies [92243d7]
- Updated dependencies [817f812]
- Updated dependencies [2f09c61]
- Updated dependencies [4f04f9b]
- Updated dependencies [ae94ba0]
- Updated dependencies [a009537]
  - @titan-design/code-graph@0.12.0

## 0.1.9

### Patch Changes

- Updated dependencies [f2aad0f]
- Updated dependencies [8939d45]
- Updated dependencies [b2abe3d]
- Updated dependencies [47a0996]
  - @titan-design/code-graph@0.11.0

## 0.1.8

### Patch Changes

- Updated dependencies [abcc9be]
  - @titan-design/code-graph@0.10.0

## 0.1.7

### Patch Changes

- Updated dependencies [dede06c]
- Updated dependencies [483f058]
  - @titan-design/rpc-protocol@0.2.0
  - @titan-design/code-graph@0.9.1
  - @titan-design/registry@0.3.1

## 0.1.6

### Patch Changes

- Updated dependencies [e44fc41]
  - @titan-design/code-graph@0.9.0

## 0.1.5

### Patch Changes

- Updated dependencies [3871f36]
- Updated dependencies [5cdc896]
  - @titan-design/code-graph@0.8.0

## 0.1.4

### Patch Changes

- 6623be9: Add Tier C audit detectors to code-graph (TP-322). Per symbol, for TypeScript and Python: `symbol_comment_lines`, `symbol_docstring_lines`, `symbol_body_lines`, `symbol_comment_ratio`, `symbol_narrating_comments` and `symbol_pass_through`. Per file: `except_count`, `except_density` (new unit `per100loc`) and `swallowed_except`. Add the `metric-outlier` check rule, which flags nodes of one kind strictly above a percentile of a metric over that kind in the snapshot, once `minSample` nodes (default 20) carry it. `INDEX_VERSION` moves to 0.17.0, so the first index after upgrading is a full one. code-read describes the new rule in a finding's `why`.
- Updated dependencies [6623be9]
  - @titan-design/code-graph@0.7.0

## 0.1.3

### Patch Changes

- Updated dependencies [90831ef]
  - @titan-design/code-graph@0.6.0

## 0.1.2

### Patch Changes

- Updated dependencies [1963d4e]
  - @titan-design/code-graph@0.5.0

## 0.1.1

### Patch Changes

- Updated dependencies [705426a]
  - @titan-design/code-graph@0.4.0

## 0.1.0

### Minor Changes

- 62bbaeb: New package: a versioned read API over code-graph snapshots (TP-184). The browser-safe `./query` subpath holds the contract (`CONTRACT`, `CODE_READ_API_VERSION` 0.1.0, zod schemas), `ReadModel` with `buildReadModel`, the `ReadSource` seam, one pure query function per command, and `createQueryResolver` for static datasets. The root adds `loadReadModel`, `createLiveSource` (SQLite with an LRU of three snapshot models), and `registerCodeReadCommands`. First commands: `api.describe` and `snapshot.list`.
- 3816475: Add `hierarchy.get`, `node.get`, and `node.resolve` (TP-185); the contract moves from 0.1.0 to 0.1.1, an additive change. The repo, directory, and class levels are synthesized at read time from file paths, qualified symbol names, and spans, because code-graph stores none of them. Directory values roll up by each metric's catalogue rule. A metric whose rule is `none`, such as most git-history counts, returns `null` for a directory with `missing: "no-rollup"` rather than a sum (directory-level history is TP-233). `node.get` adds percentile among same-kind nodes, sibling median and rank, and a delta against an optional baseline. `node.resolve` ports codewatch's search cascade and span containment. `AGENT_COMMANDS` names the commands the design puts on MCP.
- c893e50: Add `findings.list`, `finding.get`, and `node.neighbors` (TP-186); the contract moves from 0.1.1 to 0.1.2, an additive change, and the five earlier commands are byte-unchanged in `contract.lock.json`. Findings are the product's check-rule violations, derived when a snapshot loads by code-graph's own rule engine (`snapshotViolations`) and labelled `provenance: "derived"`. A finding's id is code-graph's `violationKey`. `findings.list` filters by scope, rule, severity, tool, provenance, node kind, and baseline status. It sorts by a documented total order, pages by offset (default 20 rows), and counts facets that sum to `total`. `finding.get` adds the rule's text, the measured value against its peers, related findings, and an excerpt of the flagged lines plus 5 lines of context. The live source reads the excerpt from the working tree under the new `repoRoot` dependency, only when the file still matches the snapshot. `node.neighbors` pages a stored node's inbound and outbound edges by weight with each neighbour's metric values. All three join `AGENT_COMMANDS`. `ReadModel` gains `findings` and `rules`, `ReadSource` gains an optional `readSource`, and `SnapshotStore` now includes `listFingerprints`. A derived finding disappears when its rule or threshold changes.

### Patch Changes

- Updated dependencies [ee43933]
- Updated dependencies [cb3b7e2]
- Updated dependencies [cb3b7e2]
- Updated dependencies [e3128f0]
- Updated dependencies [c893e50]
- Updated dependencies [d4b563f]
- Updated dependencies [64ffc43]
  - @titan-design/code-graph@0.3.0
  - @titan-design/registry@0.3.0
  - @titan-design/rpc-protocol@0.1.0
