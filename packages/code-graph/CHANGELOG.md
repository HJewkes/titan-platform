# @titan-design/code-graph

## 0.2.0

### Minor Changes

- 17e6d56: Port codewatch's graph analyses into `src/analysis/` (TP-127, TP-128): dead-code and growth-risk metrics computed at index time and carried forward under reuse, PageRank, seeded relevance, and symbol co-import coupling. `snapshotPageRank`, `snapshotRelevance`, `snapshotSymbolConsumers`, and `snapshotSymbolCoupling` run each query-time analysis on a store and a snapshot id. `INDEX_VERSION` moves to 0.13.0, so the first index after upgrading re-parses every file instead of reusing a snapshot that lacks the new metrics.
- 7dc61b4: Add codewatch's rules engine and snapshot diff, ported unchanged: `runChecks`, `validateRules`, `diffSnapshots`, `diffCheckResults`, their rule and result types, and a `checkSnapshot`/`loadCheckRules` entry that checks a snapshot (by id or ref) against a `check.json` with an optional baseline.
- db026d4: Add codewatch's git-history mining, ported unchanged, on a new `@titan-design/code-graph/history` subpath: `loadChurnEntries`, `parseChurnLog`, `resolveRenamedPath`, `entriesWithin`, `aggregateChurn`, `aggregateChurnWindows`, `loadFileFirstSeen`, `computeOwnership`, `authorLinesByPath`, `summarizeOwnership`, `computeChangeCoupling` and `couplingFor`. The API is path-based and imports nothing else from code-graph.

  `indexPaths` now writes churn, recency, file age, bus factor and top-author-share metrics on file nodes by default, with codewatch's metric names and windows (30, 90 and 180 days plus the primary window, and an opt-in `lifetime`). New `IndexOptions`: `computeChurn` (set `false` to skip), `churnWindowDays`, `churnWindows` and `lifetime`. Outside git the index has no history metrics.

- 16c208b: Symbol ids for methods and nested declarations change, and snapshots must be re-indexed.
  Same-named methods, constructors and nested functions in one file used to collapse into one
  symbol node keyed by bare name, merging their spans and complexity metrics (TP-182). A symbol
  id is now `<fileId>#<qualifiedName>`: `src/a.ts#Job.run`, `src/a.ts#outer.helper`,
  `src/a.ts#handlers.onClick`, and `src/a.ts#<anonymous>.run` inside a callback argument. The
  node's `name` is the qualified name. Top-level function, class, type and const ids do not
  change, and neither do file, module and external ids, edges between files, or file-level
  metrics.

  `INDEX_VERSION` is now 0.14.0, so no older snapshot is reused. The first 0.14.0 run after an
  older snapshot writes `id_alias` rows with the new `requalify` reason, from a bare-name id to
  its qualified successor, only where exactly one declaration in the file carries that name.
  `collectDeclaredNames` and `collectDeclaredSpans` now return qualified names.

- 23a8a20: Add codewatch's symbol embeddings and similar-symbol search, ported onto `@titan-design/embed` and `@titan-design/retrieval`: `embedSnapshot`, `tryEmbedSnapshot` (non-fatal), `findSimilarCapability`, `listEmbeddableSymbols`, `buildEmbedText`, `hashEmbedText`, `embedTextsCached`, and their result types. Vectors are content-addressed in the existing `blob_cache` table.
- 6d4c76e: Add codewatch's test linker, Istanbul coverage overlay and test-coverage ownership, ported unchanged: `linkTestsToSources`, `testCoverageCountMetrics`, `groupTestsBySource`, `attributeCoverage`, `COVERAGE_METRIC_NAME` and `computeTestCoverageOwnership`.

  `indexPaths` now writes `linked_test_count` on every source file that a test links to, by path convention or by co-edit history. With git history on it also writes `test_bus_factor_{w}` and `test_top_author_share_{w}` for the primary window. The names match codewatch. `coverage_pct` is not written at index time: `attributeCoverage` turns an Istanbul `coverage-final.json` into metrics for the caller to store on a snapshot.

- e851dbb: Parse `.tsx` files with the tsx grammar (TP-166). `parseFile(content, path, "typescript")` now
  picks the tsx grammar when `path` ends in `.tsx`, so JSX no longer produces an error tree.
  `ParsedFile.language` still reports the language you passed, and no type changes. The file
  filter no longer accepts `.js` or `.jsx`: `getLanguageFromPath` returns `null` for them and
  `shouldIncludeFile` returns `false`, where before they passed the filter and `parseFile`
  rejected them.

  Metric values for `.tsx` files change in `code-graph`. Cognitive and cyclomatic complexity,
  nesting depth, function counts, and symbol line spans were computed from error trees before
  and are now computed from clean ones. Symbols the broken parse invented disappear, and
  declarations it missed appear. On titan-design's `packages/ui/src`, files with parse errors
  fell from 518 to 6, and `cognitive_sum` across all files rose from 1,514 to 3,451. `INDEX_VERSION`
  moves to `0.12.0`, so the first index after upgrading rebuilds every file instead of reusing
  an older snapshot's values.

### Patch Changes

- 3fea2d3: Symbol embeddings pass `role: "document"` for symbol texts and let the retriever pass `role: "query"`, so a default nomic query carries one prefix, not two (TP-168). `FindSimilarOptions.queryPrefix` is removed before its first release; configure the embedder's `prefixes` instead. The `blob_cache` model column now holds embed 0.2's prefix-aware `embedder.model`, so vectors cached under the bare model name are re-embedded, not reused, and `findSimilarCapability` scores for nomic change.
- 336120d: New package `@titan-design/code-parser` (tier 0): `parseFile`, `getSupportedLanguages`,
  `shouldIncludeFile`, `isExcludedDir`, `getLanguageFromPath`, and the `ParsedFile` and
  `Extractor<T>` types, moved unchanged out of `code-graph`. `web-tree-sitter` is a peer
  dependency; the TypeScript and Python grammars are regular dependencies.

  `code-graph` now depends on `code-parser` and drops its direct `tree-sitter-typescript` and
  `tree-sitter-python` dependencies. Its public API is unchanged: it still re-exports
  `ParsedFile`, `Extractor`, `parseFile`, `getSupportedLanguages`, `getLanguageFromPath` and
  `shouldIncludeFile`, now from `code-parser`.

- e204012: `openCodeGraph` refuses a database stamped past `SCHEMA_VERSION` with `SchemaTooNewError`
  instead of querying a schema a newer build already moved on from.
- Updated dependencies [e204012]
- Updated dependencies [336120d]
- Updated dependencies [3fea2d3]
- Updated dependencies [3e6a4af]
- Updated dependencies [3fea2d3]
- Updated dependencies [e851dbb]
  - @titan-design/store-sqlite@0.3.0
  - @titan-design/code-parser@0.1.0
  - @titan-design/embed@0.2.0
  - @titan-design/retrieval@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [8153dd8]
  - @titan-design/store-sqlite@0.2.0

## 0.1.0

### Minor Changes

- 3108d2a: Extract `@titan-design/code-graph` from codewatch's `@codewatch/graph` (TP-9).

  That package did the job of both a store and a code graph. This splits it along that seam:
  `database.ts` / `migrations.ts` / `db-rows.ts` / `schema.sql` are gone, replaced by a
  `CodeGraphStore` composing `@titan-design/store-sqlite`'s snapshot registry, snapshot-scoped
  entity table, and content-addressed blob cache, plus four code-specific domain tables
  (`edge`, `metric`, `id_alias`, `file_fingerprint`) this package owns. No `better-sqlite3`
  dependency and no `@codewatch/*` imports remain.

  Everything code-specific came across: the tree-sitter parser (TypeScript, TSX, Python), the
  walk, the ts-morph extractor with its per-symbol reference layer, role classification,
  generated-file detection, git-rename id aliasing, and the three-tier content-hash →
  structural-hash → full-extract reuse. `indexPaths(store, { paths, ref, … })` mirrors
  `codewatch graph index`, and the node id scheme (`<fileId>#<export>`, rooted at the git
  toplevel) plus the `NodeKind`/`EdgeKind`/`role` vocabularies are byte-identical, because this
  repo's own `dag:check` consumes them.

  Python indexing is new: codewatch walked TypeScript only although the parser already had the
  grammar. The Python extractor resolves imports by dotted path rather than by type checker.

  The rules engine, the git-history metrics (churn, ownership, coupling, coverage), and the
  snapshot analyses (communities, pagerank, dead code, diff, embeddings, …) are deliberately
  not here; they are a follow-up layer on top of this package.

### Patch Changes

- Updated dependencies [aa5f694]
  - @titan-design/store-sqlite@0.1.0
