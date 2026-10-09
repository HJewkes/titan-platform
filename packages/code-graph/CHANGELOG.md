# @titan-design/code-graph

## 0.15.0

### Minor Changes

- 640a020: Add component prop metrics. A component is a PascalCase function with `symbol_jsx_depth > 0`, and its props are its first parameter. The props type resolves within the file only: an inline object type, or a same-file `interface`/`type`, following `extends` and `&` clauses that name same-file types; types the file does not declare (`HTMLAttributes<…>`) add nothing. `symbol_prop_count` counts the own-declared members, `symbol_bool_prop_count` the ones typed `boolean` or a union of `true`/`false`/`boolean` with `undefined`, and `symbol_unread_props` the ones the body never reads (a destructured binding with no references, or no `props.<name>` access); a `...rest` element or forwarding the whole props object gives 0. All three are absent when the props type is imported or the parameter is untyped, so each stays a pure function of one file. `INDEX_VERSION` moves to 0.24.0, so the next index of an existing store is a full re-index.
- 25ac9ce: `diffCheckResults` and `bucketViolations` now count a violation as worsened when it moves
  further past its threshold, rather than when its value rises. Before, a `metric-min` violation
  whose value fell, such as `coverage_pct` dropping from 60 to 40 under a minimum of 80, was
  counted as improved.

  New exports, from the root and from `@titan-design/code-graph/analysis`:

  - `violationExcess(ruleType, value, threshold)` returns how far past its threshold a violation
    sits. Larger is always worse: value over threshold for a maximum, threshold over value for a
    minimum. It returns null when the value or threshold is missing, or when the ratio has no
    meaning (a maximum of 0 or less, or a minimum rule's value of 0 or less).
  - `compareExcess(before, after)` returns `"worsened"`, `"improved"` or `"unchanged"`, or null
    when either excess is null.

  `bucketViolations` takes an optional fourth argument, `ruleTypeOf(ruleId)`; without it every
  rule is read as a maximum. `BucketableViolation` now includes `threshold`. A pair whose excess
  is null on either side stays in `unchanged` only, so it is neither worsened nor improved. A
  caller that passes values without thresholds therefore gets no worsened or improved entries.
  `delta` is still the raw `to.value - from.value`.

- 0bd5cd7: Stop counting each TS/JS `else if` as a nesting level. `nestingDepthOf` now adds no depth for an `if_statement` that is the direct child of an `else_clause`, matching ESLint `max-depth` and Sonar. `max_nesting_depth` and `symbol_max_nesting` drop for functions with else-if chains (a loop over a flat four-arm chain goes from 5 to 2). Python `elif` was already flat and is now pinned by tests. `INDEX_VERSION` is now 0.26.0 so stored nesting values are not reused.
- e54ada8: Carry git-history warnings from `indexPaths` into a new optional `IndexResult.warnings`, and add `assembleIndexerMetrics`, which returns the metrics with those warnings. A churn log overflow or git failure was previously dropped.
- ba007f1: `layered-deps` gains an `exemptTypeOnly` option. When true, an import edge whose every import
  from the source file is `import type` (or `export type … from`) no longer counts as a layer
  violation. A file that also imports a value from the same module still counts. The option is
  off by default and must be a boolean.
- 53460b5: Split cognitive complexity into logic and markup for functions that render JSX. `cognitiveSplitOf` returns the total and the share charged inside JSX `{…}` expressions. New metrics `symbol_markup_cognitive`, `symbol_logic_cognitive` and the file-level `logic_cognitive_max` are written where `symbol_jsx_depth > 0`; hook callbacks stay logic, only callbacks inline in JSX count as markup. `INDEX_VERSION` is now 0.23.0.
- 175c7a9: `topDeadModules` takes an optional fifth argument, `{ view }`. The default `"all-consumers"` view is unchanged. The `"public"` view seeds reachability only from entry, barrel, config, script and `main.*` files, and tags a row that test, story or lab files still reach with the new optional `DeadModuleRow.reachableOnlyFrom` (`"lab"` beats `"story"` beats `"test"`). Story, lab, fixture and test files are never rows in either view. New types: `DeadModuleView`, `DeadModulesOptions`, `DeadModuleConsumer`, on the root and on `./analysis`.
- cbe3679: Export `buildSymbolCouplingPayload` and its payload types from the browser-safe `./analysis` subpath, so a browser bundle no longer needs the Node-only root for it. The root export stays.
- 2159a49: The context dossier shows each symbol's own LOC beside its complexity. `collectNodeMetrics` reads `symbol_loc` onto a symbol's `loc`; `SymbolLine`, `SymbolDossier` and `BlastRadiusEntry` gain an optional `loc`; and `renderContextMarkdown` prints it on the symbol complexity line (`· **loc** N`), on file symbol rows (`, loc N`) and on blast-radius rows (`; loc N`), with a dash when unmeasured.
- f4b785f: Add a `no-import-cycles` check rule to code-graph. It reports each strongly connected component of the file import graph once, with its sorted member files in the new `members` field, and leaves type-only imports out unless `includeTypeOnly: true`. Against a baseline, a cycle inside one known cycle carries over and a cycle that gains a file is new. The TypeScript extractor now marks type-only import and re-export edges with `attrs.typeOnly`, and `INDEX_VERSION` moves to 0.25.0 so no snapshot without that mark is reused. code-read describes the new rule in plain language.
- 3428e45: Tell a git log that overflowed its buffer apart from a non-repo. `loadChurnResult` and `loadFirstSeenResult` return a typed `not-git | overflow | git-error` outcome; `loadChurnEntries` and `loadFileFirstSeen` keep returning null outside git but throw `GitHistoryError` on overflow or git failure; `LoadedHistory` gains `warnings`, so `loadHistoryMetrics` no longer drops churn, ownership and age metrics silently.

### Patch Changes

- ea8ce65: Split `resolveBarrelEdges` into small named helpers to lower its cognitive complexity; behaviour is unchanged.
- 648d9af: Correct the README's browser-safety notes: `computeSymbolConsumers` is on the `./analysis` subpath, and `buildSymbolCouplingPayload` is still root-only.
- 1f1600b: Add a test pinning that `filteredFileIds` drops `test` and `fixture` roles by default, with no `excludeRole` option.
- 8f05c8d: Rethrow non-ENOENT errors from the `.gitattributes` read in `loadGeneratedPatterns` and the realpath in the indexer, instead of treating an unreadable file or root as absent.
- c8e978e: `classifyRole` now gives a `*.fixture.*` file (for example `big.fixture.ts` beside its test) the `fixture` role, as it already did for files under a `fixtures/` directory. `INDEX_VERSION` is now 0.25.0, so a snapshot indexed with the old roles is never reused.
- f42e765: Reword the dashboard hotspot label and report comments neutrally, and credit Adam Tornhill and CodeScene for the hotspot score. No id, key or exported name changes.
- 9228402: Tighten component prop metrics. An inner binding that shadows a prop name is no longer a read of that prop, a parenthesized `(boolean | undefined)` member counts as bool, an interface that extends only imported types is absent like an all-imported `&` intersection, and PascalCase class methods and getters are not scored as components. `FC<P>` and `Readonly<P>` are not unwrapped, so their props stay absent.
- 04561ad: Split the Python dead-code binding collectors into small named helpers. Counts are unchanged.
- 1f1ca13: Document the graph report derivations in the README: `buildReportContext`, `topHotspots`, `hotspotScoreOf`, `topBusFactorRisks`, `busFactorOf`, `topTestCoverageRisks`, `topCentralFiles`, `keepNode`, `lookupMetric`, and `computeReportDrift`, with an example on the browser-safe `./analysis` subpath and a note that coupling clusters stay in codewatch.
- 20af8a3: Split `loadReuseBasis` into small named helpers to cut its cognitive complexity. Behavior is unchanged.
- 9fcd1b3: Remove an `indexer.test.ts` case that claimed to assert incremental-reuse equivalence but ran two full indexes, and point the README and reference page at `incremental-index.test.ts`, which compares full snapshots against a fresh full index.
- 6ecc31d: Share one tree-sitter node-kind table (`node-kinds.ts`) across declared-names, scope-path, source-metrics, cognitive-complexity, dead-code and growth-risk. Each module keeps its exact former set; no metric output changes.
- 388d791: Review nits: code-graph gains `excludeRoles` barrel and fixture test cases and a virtual-source index test that fails on any direct filesystem read; the session-graph price-prefix doc now names the combined `-YYYYMMDD[..]` form.
- c043041: A forbid-import `except` entry now matches one exact path unless it contains `*`, instead of any path containing it, and an empty `except` entry is refused when rules load instead of silently disabling the rule.
- ff6ff86: Type the graph-report README example against `GraphNode`, and pin more behavior in tests: a braced `else { if }` in a loop nests at depth 3, carried reuse-basis metrics include dead-code and growth-risk names. No runtime change.
- Updated dependencies [5fe09ab]
- Updated dependencies [1f7de27]
  - @titan-design/retrieval@0.3.1
  - @titan-design/store-sqlite@0.4.0

## 0.14.0

### Minor Changes

- 14c4299: Add `loc` to `HotspotRow` and `UnusedExportRow`, matching codewatch's graph report. `topHotspots` reads the file `loc` metric and `topUnusedExports` reads `symbol_loc`; both give 0 when unmeasured, and drift's `newHotspots` carry it through. No index contents change, so `INDEX_VERSION` stays.

### Patch Changes

- 2c0fff9: Derive `NodeRole` and `NodeKind` from exported `NODE_ROLES` and `NODE_KINDS` arrays, so `excludeRoles` accepts every role (including `generated` and `script`).

## 0.13.0

### Minor Changes

- b4f9472: Add the browser-safe `@titan-design/code-graph/analysis` subpath, which re-exports the report, dashboard, and package-architecture derivations without the root's Node-only dependencies. `forbid-import` rules take an optional `except` list of destination patterns the rule allows.
- 689c518: Export `computeSymbolConsumers` and `linkTestsToSources` from the browser-safe `./analysis` subpath. `parseSymbolId`, `symbolId`, and `SYMBOL_ID_SEP` move to a module with no Node imports (still re-exported where they were), and the test linker reads `couplingFor` without the git history modules, so both derivations can run in a browser.
- 1743211: Export `bucketViolations`, the store-free core of `diffCheckResults`, from the root and from the browser-safe `./analysis` subpath. It buckets two violation lists as new, resolved, unchanged, worsened, or improved, with an optional id resolver for moved files. `violationKey` and `rebasedViolationKey` now accept any value with `ruleId`, `nodeId`, and `destinationId` (`ViolationIdentity`).
- 445c85c: Add the context dossier and bundle builders, ported from codewatch's `graph context` with unchanged behavior. `buildContextDossier(input)` projects one file or symbol into a `ContextDossier` (metrics, churn, centrality, ownership, source and test consumers, coupling, blast radius, per-symbol importance), and `renderContextMarkdown(dossier)` renders it as markdown. `buildContextBundle(input)` adds the target's source span, its edges as explicit callers, dependencies and coupling partners (ordered by seeded relevance when `relevanceByFile` is given), and coverage; `renderBundleText(bundle)` concatenates it for an embedder. The dossier's schema version is exported as `CONTEXT_SCHEMA_VERSION`, and the bundle's as `BUNDLE_SCHEMA_VERSION`.
- 4722ea7: Add `topDeadModules`, `topUnusedExports` and `publicApiFiles`, ported unchanged from codewatch's `graph report` unused-export and unreferenced-file sections.
- ab1b1c0: Add `gitTreeSource(repoRoot, rev)`, an `IndexSource` that indexes a commit's tree straight from git objects (`git ls-tree -r -z` plus one `git cat-file --batch`) without a checkout and without writing to the repo. Node ids are byte-identical to a working-tree index of the same commit: they are rooted at the realpath'd repo root, even when an indexed subdir no longer exists on disk. The snapshot's `commitHash` defaults to the source's commit, which the alias bridge also uses. `IndexSource` gains an optional `revision` field (`repoRoot`, `commit`, `commitEpoch`) that the working-tree source leaves unset. The git plumbing is exported from `@titan-design/code-graph/history` as `resolveCommit`, `listTreeBlobs` and `readBlobs`.

  Fidelity caveat: a path is resolved one component at a time, as a checkout of the commit would resolve it. A component the commit tracks is the commit's own file, dir or symlink, whatever today's disk has there, and a tracked symlink is followed through the target recorded in its blob; any other component is looked up on disk, following symlinks. So files in the repo, including `tsconfig*.json`, `package.json` and `.gitattributes`, come from the commit, and so does a workspace package reached through a `node_modules` link into the repo. A tracked symlink whose target leaves the repo resolves on disk, as a checkout's would; a dangling or looping one is missing. Installed packages in `node_modules`, and build output under an excluded dir (`dist/`, `build/` and the like) beneath a dir the commit tracks, are read from today's disk when the commit does not track them. That includes a file under such a dir that a later commit tracks but this commit lacks. The test is the excluded-dir list, not `.gitignore`: an untracked, unignored file under `vendor/` or `build/` beneath a tracked dir is read from disk too, so it can resolve an import at the revision that a clean checkout of the commit, which never has that file, could not. An import of a package whose installed version or build differs from the revision's resolves against the current install.

  History metrics are off for a revision: an index from `gitTreeSource` records no churn, recency or ownership metrics until history can be read up to a revision (TP-1472), rather than reporting HEAD's history.

- 7682bd6: `computeHealth` takes optional caller weights and caps as a second argument, and each component now carries a stable `key` and its `cap`. `DEFAULT_HEALTH_WEIGHTS` and the `HealthWeights` types are exported from the root and the `./analysis` subpath.
- 1dc1a3b: Read churn, recency and ownership up to a revision. `loadChurnEntries` takes an optional `rev` to walk `git log` from instead of HEAD, and an optional `untilEpoch` that finite windows end at instead of the wall clock. `loadFileFirstSeen` takes the same optional `rev`. `HistoryMetricsOptions` gains `rev`, which goes with `nowEpoch`.

  An index from `gitTreeSource` now records history metrics. Before, it recorded none. `churn_{w}`, `recency_{w}`, `file_age_days`, `bus_factor_{w}` and `top_author_share_{w}` come from history up to the source's commit, and their windows end at that commit's time. Commits made after it do not count. A working-tree index without a source still reads HEAD, with windows ending at the wall clock, so its output is unchanged.

- 3a2dfcc: Export `hotspotComplexityOf(ctx, nodeId)` from `@titan-design/code-graph/analysis`: the complexity factor a file's hotspot score multiplies (max cognitive, else max cyclomatic), read even when the file has no churn, and undefined when unmeasured. code-read's `paths.impact` reports it.
- c32abb7: Add JSX tree depth metrics. `symbol_jsx_depth` is the most rendered JSX elements on one ancestor chain in a function: fragments add nothing, the walk continues through `{…}` containers and inline callbacks, JSX in an attribute sits one below its owner, and a nested named function is scored on its own. `jsx_depth_max` is the file's maximum over its functions and module-scope JSX. Both are written only when greater than 0, so plain TypeScript and Python files emit neither. `max_nesting_depth` keeps its control-flow meaning. `INDEX_VERSION` moves to 0.20.0, so the next index of an existing store is a full re-index.
- 887982d: Add `minifySource(text, language)`, a safe minify for source emitted into LLM context. For TypeScript, TSX and Python it drops comments and docstrings, strips trailing whitespace, collapses blank-line runs and replaces a leading import block with one `importMarker` line (`// … N imports`, `# … N imports` in Python). It never renames or dedents, and other languages come back unchanged with an identity line map.

  Usage: `const { text, lineMap } = await minifySource(source, "typescript");` then `originalLine({ text, lineMap }, n)` gives the 1-based file line of output line `n`; the marker maps to the first import line.

- d7fa488: Export `computePartitionQuality` and its `PackageStats`, `PairCoupling`, `PartitionQualityInput`, and `PartitionQualityResult` types from the browser-safe `./analysis` entry, so a static reader can compute package stats.
- c65fce1: Add the `story` and `lab` file roles. `story` is built in: `*.stories.{js,jsx,ts,tsx}` (with an optional `c`/`m`) and `*.mdx`, checked right after `test`, so the filename beats a `fixtures/` or `scripts/` directory. `lab` has no built-in rule; a repo assigns it, or any role, with `.gitattributes`-style globs in `.codewatch/roles.json`, read by the new `loadRoleGlobs(repoRoot)` and passed to `annotateRoles` as `roleGlobs`. Configured globs beat every built-in heuristic, and `generated` still wins outright. Rule `excludeRoles` accepts both new roles. `INDEX_VERSION` moves to 0.21.0, so the next index of an existing store is a full re-index. The new `UNIMPORTED_ROLES` set names the roles nothing imports by design; dead-module reachability seeds from it plus `barrel`, so story and lab files are no longer reported dead.
- 402654f: Add `renderSignatureTree(nodes, { maxLineChars })`, a pure signatures-only tree render for LLM context: a header per file, one line per symbol (`attrs.signature`, else `<name> (<kind>)`) in line order, an `ELISION_MARKER` line between non-adjacent symbols, and every line truncated at `maxLineChars` (default `DEFAULT_MAX_LINE_CHARS`).
  Usage: `import { renderSignatureTree } from "@titan-design/code-graph"; const text = renderSignatureTree(graph.nodes, { maxLineChars: 100 });`
- add80d0: Add `topGrowthRisks` and `topUntestedRisks`, ported unchanged from codewatch's `graph report` scaling-smell and untested-hotspot sections.
- f38088f: Route every file the indexer reads through a new `IndexSource` seam, set by `IndexOptions.source`. A source lists files, reads them, answers existence checks, and supplies the ts-morph `FileSystemHost` used for import resolution and tsconfig. `workingTreeSource()` is the default and wraps the existing `node:fs` calls, so output is unchanged and `INDEX_VERSION` stays at 0.19.0. `readSourceFiles`, `loadGeneratedPatterns`, `computeRoleHints`, `PythonGraphExtractor` and the extractor options take an optional source that defaults to the working tree.
- 2b1f4d3: `layered-deps` accepts `excludeRoles`, validated like the metric rules' option: an import is dropped when its source or destination file has an excluded role. Each violation's message now names the source and destination files as well as their packages and layers.

### Patch Changes

- 9327cb0: Abstract classes, `function*` declarations and generator expressions bound to a `const` now get symbol nodes with line spans, and every generator gets function-count, cyclomatic, cognitive and per-symbol metrics. A nested function or generator expression also adds cognitive nesting. Both checks now read their function node types from shared sets in scope-path. `INDEX_VERSION` moves to 0.22.0, so existing indexes rebuild.
- 4c8013a: Match `.gitattributes` `linguist-generated` patterns the way git does: a leading `/` anchors to the repo root, a non-final `**` segment matches zero or more directories (`**/x.ts` matches a root `x.ts`, `a/**/b.ts` matches `a/b.ts`), and a later `-linguist-generated` line opts a path back out because the last matching line wins.
- f8f49ee: `isGeneratedFile` no longer marks files inside a directory for a trailing-slash `.gitattributes` pattern such as `vendor/ linguist-generated`. Git matches that pattern to the directory only, not to paths inside it, so `vendor/x.js` is not generated.
- c0420d2: LCOM metrics now score decorated Python methods (skipping only `@staticmethod` and `@classmethod`) and count abstract TypeScript classes and class expressions, taking the class node types from a shared `TS_CLASS_TYPES` set in scope-path.
- 326a235: Pin that a throw part-way through `indexPaths` leaves no truncated snapshot behind.
- bece4b2: Write each indexed snapshot row together with its nodes, edges, aliases, metrics and fingerprints in one transaction, so a reader on another connection never sees a head snapshot whose rows are partly written. Adds `CodeGraphStore.atomically`.
- 1d1b6fa: Sign an overloaded class member by its implementation (a declaration file with no implementation keeps its first overload), and sign a getter/setter pair as the property it exposes, `name: type`, from the getter's declared or inferred return type (a lone setter uses its parameter's type). Qualified member names now resolve through one name map per file, built once per extraction pass, instead of a whole-file walk per name. `INDEX_VERSION` moves to 0.19.0, so the first index after upgrading re-extracts every member signature.
- 1805bce: `gitTreeSource` fixes. A link chain cut short by the 40-hop budget no longer poisons the memo for a shorter chain that shares its tail: each path component is resolved once per remaining hop budget, so a 30-link chain still resolves after a 45-link chain was found looping. A tracked symlink's target resolves `..` one component at a time, as a checkout does, so `../gone/../x` dangles when `gone` is absent instead of normalising to `x`, and a link named many times in nested targets is still followed once per budget rather than once per mention. Both sources now hand the indexer a sorted file list, so a snapshot's float metrics (utilization summed across a barrel's shares) are byte-identical whether the files came from `git ls-tree` or a `readdir` walk.
- e6dd995: `minifySource` no longer adds a space where it cuts a JSX `{/* */}` comment between two elements or fragments (`</b>{/*c*/}<i>` now gives `</b><i>`); a cut between two words of JSX text still leaves one space.
- 4662078: Describe cyclomatic and cognitive complexity as attention pointers and comprehension friction rather than risk, credit Adam Tornhill and CodeScene where the hotspot score is described, and retitle the context dossier's blast-radius heading "look here first". No metric id, rule id or JSON key changes.
- Updated dependencies [ea96b66]
- Updated dependencies [f886302]
  - @titan-design/store-sqlite@0.3.3

## 0.12.0

### Minor Changes

- 4f04f9b: Add the graph report derivations ported from codewatch: `buildReportContext`, `topHotspots`, `hotspotScoreOf`, `topBusFactorRisks`, `busFactorOf`, `topTestCoverageRisks`, `topCentralFiles`, `keepNode`, `lookupMetric`, `computeReportDrift`, and the report row types. Coupling clusters stay in codewatch because they read `git log` at report time.
- ae94ba0: Add the package architecture stats ported from codewatch's `graph arch`: `computeArch`, its steps `filteredFileIds`, `aggregateEdges`, `toSortedEdges` and `packagesReferencedByEdges`, `bucketFilesByPackage`, the constants `EXTERNAL_BUCKET` and `DEFAULT_MAX_PACKAGE_SIZE`, and their types (`ComputeArchInput`, `PackageRoot`, `ArchResult`, `ArchPackage`, `ArchSubNode`, `ArchEdge`).
- a009537: Add the dashboard derivations ported from codewatch's `graph dashboard`: `collectNodeMetrics`, `collectSymbolUtil`, `buildNodeMetrics`, `buildCentralFiles`, `buildHotExports`, `buildBlastRadius`, `referencedNodes`, `buildSymbolCouplingPayload`, `computeHealth`, the coupling classifier `classifyCoupling` with its `pairKey`, and their types (`NodeMetrics`, `SymbolUtil`, `HotExport`, `BlastRadiusEntry`, `SymbolCouplingPayload` and rows, `HealthComponent`, `SnapshotContext`, `CouplingClass`).

### Patch Changes

- 5958e6e: Document the `<anonymous>` segment in symbol ids. An unbound callback, object or class adds one `<anonymous>` segment, and consecutive anonymous scopes collapse to one, so `src/a.ts#App.<anonymous>.onHash` is the id of a function declared inside a callback in `App`. Ids do not change; the README previously said anonymous scopes add no segment. Regression tests pin the rule.
- 92243d7: Resolve qualified member symbols (`Box.add`, `outer.helper`) in `computeDeepAst` and in index-time signatures for non-exported methods and nested functions, which previously reported "declaration not found in source" or stored no signature.
- 817f812: Rewrap an overlong line in the README symbol-id section.
- 2f09c61: `validateRules` now rejects a rule whose `severity` is not `"error"` or `"warning"`, whose metric `kind` is outside `NodeKind`, or whose `exclude` is not a string array. These used to load silently: `"Error"` counted as a warning so the check still passed, a misspelled `kind` matched no node, and a string `exclude` was dropped.
- Updated dependencies [3a4d4ed]
  - @titan-design/store-sqlite@0.3.2

## 0.11.0

### Minor Changes

- f2aad0f: Add `diffFootprints(store, { fromSnapshotId, toSnapshotId })`: the symbols whose footprint differs between two snapshots, as `added`, `removed` or `changed` with reasons `signature`, `consumers`, `coupling` or `renamed`, plus a rollup to declaring files. From-side ids follow the alias chain, and a symbol under a moved file follows its file, so a move with an unchanged footprint reports `["renamed"]` alone.
- 8939d45: Add the per-unit doc gate. `unitProvenance({ unit, footprints, snapshot, model })` records a unit's symbol-set hash with the snapshot's commit hash, and `gateUnits({ prior, units, footprints })` returns the units to regenerate (`new` or `changed`), the units to skip, and the prior units that are orphaned. When every hash matches its prior record, `regenerate` is empty and the caller makes no LLM call.

### Patch Changes

- b2abe3d: The ts-morph extractor drops extracted source files from its own Project in batches, cutting the indexer's live heap peak from about 1000 MB to about 460 MB on this repo with an identical graph.
- 47a0996: diffFootprints no longer drops a symbol when two files merge into one: the losing from-symbol is reported as removed.

## 0.10.0

### Minor Changes

- abcc9be: Add `computeFootprints` and `symbolSetHash`: a per-symbol structural footprint (signature, consumers and co-import coupling part hashes) and an order-independent hash over a unit's symbols.

## 0.9.2

### Patch Changes

- 4016965: The ts-morph extractor without a tsconfig now loads automatic `@types` from the indexed repo's `node_modules/@types` chain instead of from `process.cwd()`. Inferred signatures no longer depend on where the indexer runs, and indexing a tree outside the caller's workspace no longer parses the caller's `@types` (the cause of the slow incremental-index tests, TP-442).

## 0.9.1

### Patch Changes

- 483f058: Only use a prior snapshot as the alias base when its commit is an ancestor of the indexed commit. A force-pushed ref no longer yields spurious rename aliases, or carried-over violations, from an unrelated pre-rewrite snapshot.

## 0.9.0

### Minor Changes

- e44fc41: Store audit findings and model verdicts against a snapshot (TP-355). Migration 4 adds
  snapshot-scoped `finding` and `verdict` tables, pruned with their snapshot. `findingKey`
  identifies a finding by tool, signal, innermost symbol (or path), a hash of the normalized
  flagged text, and a collision ordinal, so it survives inserted lines, unlike `Finding.id`.
  New exports: `keyFindings`, `saveFindings`, `listFindings`, `saveVerdicts`, `listVerdicts`,
  `carryForwardVerdicts` (copies a verdict when key and excerpt hash both match).

  `SCHEMA_VERSION` is now 4, so an older code-graph build refuses a database this one opened.
  `INDEX_VERSION` is unchanged.

## 0.8.0

### Minor Changes

- 3871f36: Emit `calls` edges between symbols (TP-323). TypeScript resolves each call and `new` through the type checker; Python resolves same-file module-level names, `from <in-repo module> import` names, and `self.<name>()` on the enclosing class or a same-file base. Unresolved calls are dropped. Each edge carries its call sites' literal arguments in `attrs.sites`, and function and method symbol nodes carry `params`. New per-symbol metrics: `symbol_caller_count`, `symbol_single_caller_helper` and `symbol_constant_params`. `listEdges` and `listEdgesTouching` hide `calls` edges by default, like `references`. `INDEX_VERSION` moves to 0.18.0, so the first index after upgrading is a full one.
- 5cdc896: Add `floor` and `rankNonZero` to the `metric-outlier` check rule so a sparse metric whose percentile sits at or near zero no longer flags every non-zero node. Exempt Python's `except ImportError`/`ModuleNotFoundError` handlers (alone or paired, `pass` or a None-assignment fallback) from `swallowed_except`, since that is the standard optional-dependency idiom rather than a hidden error.

## 0.7.0

### Minor Changes

- 6623be9: Add Tier C audit detectors to code-graph (TP-322). Per symbol, for TypeScript and Python: `symbol_comment_lines`, `symbol_docstring_lines`, `symbol_body_lines`, `symbol_comment_ratio`, `symbol_narrating_comments` and `symbol_pass_through`. Per file: `except_count`, `except_density` (new unit `per100loc`) and `swallowed_except`. Add the `metric-outlier` check rule, which flags nodes of one kind strictly above a percentile of a metric over that kind in the snapshot, once `minSample` nodes (default 20) carry it. `INDEX_VERSION` moves to 0.17.0, so the first index after upgrading is a full one. code-read describes the new rule in a finding's `why`.

## 0.6.0

### Minor Changes

- 90831ef: Add per-symbol `symbol_loc` and `symbol_max_nesting` metrics for TypeScript and Python functions (TP-317), and compute the `unreachable_statements`, `unused_locals` and `unused_params` dead-code metrics for Python files (TP-318). `INDEX_VERSION` moves to 0.16.0, so the first index after upgrading is a full one.

## 0.5.0

### Minor Changes

- 1963d4e: Metric rules with `kind: "symbol"` now evaluate symbol nodes (TP-251); rules without `kind` keep the file graph. Metric violations carry `path`, `lineStart`, `lineEnd`, `symbol`, `evidence` and `tool`. New `Finding` type with `toFindings` and `externalToFinding`.

## 0.4.0

### Minor Changes

- 705426a: Add the convention layer, ported from codewatch (TP-130): `detectCommunities` (deterministic greedy-modularity communities with a `targetCount` and size cap), `buildConventionAreas`, `summarizeConventions` (injected `Summarizer`, summaries cached in `blob_cache` under `code-graph/community-summary` by model and prompt hash, returns hit and miss counts), `getConventionMap`, and `findConventions` (ranks areas for a question by summary embedding). No schema change.

## 0.3.0

### Minor Changes

- ee43933: Add a metric catalogue and targeted store reads for the read API (TP-183). `METRIC_CATALOGUE`, `describeMetric`, and `describeMetrics` describe every metric name code-graph writes: unit, node kinds, rollup rule, direction, what a missing row means, and the writing module, with windowed names as `{w}` templates. `listMetricsForNode`, `listEdgesTouching`, and `aggregateMetrics` (also on `CodeGraphStore`) read one node or one metric through existing indexes. Additive: no schema migration, no new index, no `INDEX_VERSION` change.
- c893e50: Add `snapshotViolations(store, snapshotId, rules)`: every rule's violations in one snapshot, with no baseline. It takes any `RuleStore`, meaning a store with `listNodes`, `listEdges`, and `listMetrics`, instead of the concrete `CodeGraphStore`. code-read derives its findings with it and keys them with `violationKey`, the same key the ratchet uses.
- d4b563f: Identity that survives renames (TP-187). Id aliases now chain across snapshots: `resolveAlias(store, id, toSnapshotId, { fromSnapshotId })` carries `a.ts` renamed to `b.ts` renamed to `c.ts` from the first snapshot to the last, in either direction, with a bounded walk. `aliasChain` returns the reusable resolver, and `priorSnapshotForRef` finds the snapshot a git ref or ref label denotes before a given snapshot. A file rename now also writes symbol aliases, so `a.ts#Job.run` follows its file. The ratchet is rename-aware: carryover (`runChecks`, `checkSnapshot`) and `diffCheckResults` key a violation after carrying its baseline ids through the alias chain, so a moved file's violations carry over instead of reading as one resolved plus one new. Unmoved ids key exactly as before (`violationKey`, now exported with `rebasedViolationKey`). `diffSnapshots` follows the whole chain instead of the to-snapshot's aliases alone.

  `INDEX_VERSION` is now 0.15.0. Each snapshot records its alias base in `attrs.aliasBase`, and a new index of a ref computes its aliases against that ref's newest committed snapshot, falling back to the newest committed snapshot of any ref. No schema migration: stores written by 0.14.0 open and read unchanged, including read-only ones, and their lineage is inferred the way the 0.14.0 indexer chose its prior snapshot. As with every bump, a 0.14.0 snapshot is never a reuse basis, so the first 0.15.0 index is a full one.

- 64ffc43: Export the batch the final codewatch swap needs, and port partition quality and prune (TP-250).

  New root exports, all already implemented internally: the history adapter (`loadHistoryMetrics`, `LoadedHistory`, `HistoryMetricsOptions`, `DEFAULT_CHURN_WINDOWS`, `resolveChurnWindows`, `windowSuffix`, `computeRecencyWindows`), which stays outside the `./history` seam because it speaks `GraphMetric`; the rules engine's glob matching (`patternToRegex`, `compilePatterns`, `matchesAny`); `computeDeepAst` with `DeepAst`, `DeepAstInput`, `MemberInfo`, and `ParamInfo`; and `resolveGitRef`.

  New `CodeGraphStore` methods: `listMetricNames`, `topByMetric`, and `replaceMetricsByName` (the wholesale swap a re-ingested overlay such as coverage needs), plus `deleteSnapshots`, `vacuum`, and `countRowsByTable`.

  Ported from codewatch's `packages/graph` unchanged, with their tests: `computePartitionQuality` and `invertBuckets` (`src/analysis/partition-quality.ts`), and `planPrune` and `runPrune` (`src/prune.ts`). The domain tables declare no foreign key, so `deleteSnapshots` clears each of `SNAPSHOT_SCOPED_TABLES` itself instead of relying on codewatch's cascade; `boundary` and `entry_point`, which this schema never created, leave the list.

  Additive: no schema migration, no new index, no `INDEX_VERSION` change (still 0.15.0). When this releases, codewatch deletes its `packages/graph/src/history-adapter.ts` copy and consumes these exports instead.

### Patch Changes

- Updated dependencies [825b8b2]
  - @titan-design/store-sqlite@0.3.1

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
