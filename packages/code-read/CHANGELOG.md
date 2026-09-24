# @titan-design/code-read

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
