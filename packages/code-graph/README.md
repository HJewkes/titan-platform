# @titan-design/code-graph

The dependency graph of a TypeScript or Python tree: files, modules, exported and internal
symbols, external packages, and the import / re-export / reference edges between them, with
index-time source metrics, in one SQLite file built from `@titan-design/store-sqlite` kit
tables and refreshed incrementally.

Tier 2 of the titan-platform DAG. Depends on `store-sqlite`, `code-parser` (tree-sitter WASM
parsing and the file filter), `ts-morph`, `web-tree-sitter` for node types, and `embed` plus `retrieval` for similar-symbol search. Extracted from codewatch's `@codewatch/graph` (TP-9), split along the seam the
audit identified: that package did the job of both a store and a code graph.

```ts
import { indexPaths, listEdges, listNodes, openCodeGraph } from "@titan-design/code-graph";

const store = openCodeGraph(".codewatch/graph.db");
const { snapshotId, files, nodes, edges, reused } = await indexPaths(store, {
  paths: ["packages", "products"],
  ref: "head",
});
listNodes(store, snapshotId); // file / module / external nodes, symbols on request
listEdges(store, snapshotId); // imports / re-exports, references on request
```

## What was extracted, and what was not

In: the parser (tree-sitter WASM for TypeScript, TSX and Python, since moved to
`@titan-design/code-parser` and still re-exported here), the walk, the ts-morph
extractor and its symbol layer, role classification, generated-file detection, id aliasing
across git renames, the three-tier incremental reuse, and the metrics computed at index time
(degree, utilization, loc, cyclomatic, cognitive, nesting, class count, lcom4, per-symbol
complexity). `lcom.ts` came along despite being an analysis: `source-metrics.ts` calls it
directly and lcom4 is a pure function of a file's bytes, so it belongs with the metrics that
carry forward under reuse.

Ported later (TP-123, TP-124), strictly as codewatch had them: the rules engine
(`check*.ts`, now `src/check/`) and the snapshot diff plus check diff (`diff.ts`,
`check-diff.ts`, now `src/diff/`). See [Checks and diffs](#checks-and-diffs).
Ported with TP-127 and TP-128: dead code, growth risk, PageRank, relevance, and symbol
coupling, now `src/analysis/`. See [Graph analyses](#graph-analyses).
Ported with TP-133: the test linker and the Istanbul coverage overlay, also in `src/analysis/`,
and test-coverage ownership. See [Test linking and coverage](#test-linking-and-coverage).

Deferred, all of it still in codewatch, all of it a follow-up on this package rather than a
change to it:

- Graph analyses over a finished snapshot: communities, partition quality, conventions,
  patterns, prune, reuse-delta reporting.

Python support is new here rather than ported. codewatch walked TypeScript only; the parser
already had the grammar. The Python extractor is deliberately narrower than the ts-morph one:
no type checker, so imports resolve by dotted path against the tree and symbols come from the
same tree-sitter declaration walk that feeds complexity.

## The id scheme

Preserved exactly from codewatch, because this repo's own `dag:check` consumes it through
codewatch's CLI:

- A **file** id is its path relative to the git toplevel, in posix form:
  `packages/registry/src/index.ts`. Ids root at the git toplevel even when you walk a
  subtree, so importers across subtrees share one id space.
- A **module** id is the file id minus its extension: `packages/registry/src/index`. Its
  parent is the directory above it.
- A **symbol** id hangs under its declaring file as `<fileId>#<name>`. `#` is legal in
  neither a posix path nor a JS identifier, so the first one is the split.
- An **external** id is `npm:<package>` (scope-aware) or the `node:` builtin verbatim.

`NodeKind`, `EdgeKind`, and the `role` vocabulary are unchanged. So is the property the DAG
check rests on: an import of a workspace package by its published name resolves to that
package's source file, not to an `npm:` external, by remapping the `dist/*.d.ts` entry
ts-morph resolves back onto `src/`. That remap needs the target package built, which is why
`pnpm build` precedes both `pnpm test` and `dag:check`.

## The three reuse tiers

Every run writes a fingerprint per file: a content hash and a comment/whitespace-insensitive
hash of its parse structure. The next run diffs against the most recent snapshot carrying the
same `INDEX_VERSION` and sorts each file into one tier. `INDEX_VERSION` is bumped whenever a
metric can change for the same bytes, not only when the node or edge shape changes: 0.12.0
marks `.tsx` files moving to the tsx grammar, which changed their complexity metrics and
symbol spans; 0.13.0 marks the dead-code and growth-risk metrics joining the carry-forward set.

| Tier | Trigger | Work skipped |
|---|---|---|
| reuse | content hash matches | parse and extract both; nodes, edges and source metrics carried forward verbatim |
| cosmetic | content changed, structural hash matches | the ts-morph extract; edges come from the basis, symbol line spans are refreshed from the fresh parse |
| full | structural hash changed, or the file is new | nothing |

A file-membership delta (a file added or removed) forces the files whose imports it
re-resolves back to full extraction even when they are byte-identical. Degree metrics are
always recomputed over the whole assembled graph, so a heavily-reused run and a
`incremental: false` run produce the same snapshot; `indexer.test.ts` asserts that.

## Store layout

`openCodeGraph` opens the database with the kit's pragmas and runs three migrations.

It refuses a database stamped past `SCHEMA_VERSION` with `SchemaTooNewError`: a code graph
database belongs to one build, so a higher version means a newer build already moved the
schema and this one would query columns that are gone.

Kit tables: `snapshot` (the snapshot registry), `node` (`entity_snap`, keyed
`(snapshot_id, id)`), `blob_cache` (content-addressed, for the embedding and summary caches
an analysis layer will want). Migration 2 adds four columns the kit shapes do not carry but
every consumer reads directly: `node.language`, `node.role`, `snapshot.commit_hash`,
`snapshot.index_version`.

Domain tables in `schema.ts`: `edge` (snapshot-scoped, keyed
`(snapshot_id, src_id, dst_id, kind)` — the kit's own edge table is bi-temporal, which is the
wrong time model for a population re-indexed all at once), `metric`, `id_alias`, and
`file_fingerprint`.

The symbol layer is hidden by default. `listNodes` drops `symbol` nodes and `listEdges` drops
`references` edges unless you ask for them, so a caller reasoning about module structure sees
the graph it expects and does not have one import of thirty names read as thirty
dependencies.

## Checks and diffs

The rules engine turns a snapshot into pass/fail against a `check.json`. Six rule types:
`metric-max`, `metric-min`, `metric-product-max`, `forbid-import`, `layered-deps`, and
`no-internal-only-barrels`. Severity defaults to `error`; only new errors fail a check.

```ts
import { checkSnapshot, loadCheckRules, openCodeGraph } from "@titan-design/code-graph";

const store = openCodeGraph(".codewatch/graph.db");
const rules = await loadCheckRules(".codewatch/check.json", { onWarn: console.warn });
const { result } = checkSnapshot(store, { snapshot: "head", baseline: "main", rules });
result.passed; // false only when a violation is an error and absent from the baseline
```

`snapshot` and `baseline` take a numeric snapshot id or a ref name; a ref resolves to its
newest snapshot. `runChecks(store, { snapshotId, rules, baselineSnapshotId })` is the same
engine on ids, and `validateRules(json)` validates an already-parsed rules object.

The baseline is a ratchet. A violation whose key (rule id, node id, and destination id for
edge rules) also fires on the baseline snapshot is marked `isCarryover` and counts as
carryover, so existing debt does not block a change but new debt does. Deprecated metric and
role spellings in a rules file (`lines`, `tests`) heal to their canonical names with a
warning through `onWarn` instead of failing validation.

`diffSnapshots(store, { fromSnapshotId, toSnapshotId })` reports added, removed and renamed
nodes, added and removed edges, and metric deltas on nodes present in both. The
to-snapshot's `id_alias` rows carry a renamed file across, so a move reads as a rename rather
than a delete plus an add, and its edges do not churn. Metric and edge-kind spellings are
canonicalised before comparing.

`diffCheckResults(store, { fromSnapshotId, toSnapshotId, rules })` runs the rules on both
snapshots and buckets each violation as new, resolved, or unchanged; unchanged metric
violations are further split into worsened and improved by value.

`scripts/dag-check-self.mjs` in the repo root runs this repo's DAG check on this engine
instead of codewatch's CLI.

## Similar symbols

Ported from codewatch's `embeddings.ts` (TP-129). It answers "does something like this
already exist?" before you write it. The embedder is injected; this package never builds
one and never talks to a network on its own.

```ts
import { OllamaEmbedder } from "@titan-design/embed";
import { findSimilarCapability, tryEmbedSnapshot } from "@titan-design/code-graph";

const embedder = new OllamaEmbedder();
const attempt = await tryEmbedSnapshot(store, snapshotId, embedder);
// { ok: true, result: { symbols, embedded, withPurpose, newlyEmbedded, reused, model } }
// or { ok: false, model, error } when the backend is down; the snapshot is unaffected
const { candidates, coverage } = await findSimilarCapability(store, snapshotId, "parse a duration", embedder);
```

- **Corpus.** Exported symbols with a signature, minus test, fixture and generated files.
  The embedded text is `signature -- purpose` (the docstring), never the body.
- **Storage.** Vectors go in `blob_cache` under namespace `code-graph/symbol-embedding`,
  keyed by `embedder.model` and the SHA-256 of the text. They are not snapshot-scoped, so
  re-embedding unchanged text costs zero embed calls. `embedSnapshot` throws on a backend
  failure; `tryEmbedSnapshot` reports it.
- **Query.** `vectorRetriever` over a `BruteForceVectorIndex` from `retrieval`. The query is
  embedded with role `query` and the symbol texts with role `document`; the embedder applies
  the matching prefix (`search_query: ` / `search_document: ` for nomic models).
- **Results are candidates, not verdicts.** Each has a cosine score, and `coverage` says how
  many symbols were searchable and how many carry purpose text. There is deliberately no
  co-location filter.
- **Python symbols are not in the corpus yet.** The Python extractor records no signature or
  docstring, so no Python symbol passes the corpus filter.
- **Prefixes are part of the cache key.** `embedder.model` includes a hash of the embedder's
  prefix table, so two prefix configurations never share a vector. codewatch used no prefix;
  `new OllamaEmbedder({ prefixes: { document: "", query: "" } })` reproduces its rankings.

## Graph analyses

Dead-code and growth-risk metrics are computed at index time, like the source metrics, and
carry forward for unchanged files. Both are sparse: a file gets a row only when a count is
above zero.

- Dead code, TypeScript only: `unreachable_statements` (after a `return`, `throw`, `break`
  or `continue` in the same block), `unused_locals`, and `unused_params` (trailing run only).
- Growth risk, TypeScript and Python: `loop_depth` (at 2 or more), `recursive_functions`,
  and `search_in_loop` (`.includes`, `.find` and similar inside a loop). These are smells,
  not complexity bounds. Recursion and search match TypeScript call nodes only, so Python
  files get `loop_depth` alone, as in codewatch.

PageRank, relevance, and symbol coupling run at query time over one snapshot:

```ts
import {
  snapshotPageRank,
  snapshotRelevance,
  snapshotSymbolCoupling,
} from "@titan-design/code-graph";

snapshotPageRank(store, snapshotId); // global centrality over the file-level graph
snapshotPageRank(store, snapshotId, { personalization: new Map([[fileId, 1]]) }); // seeded
snapshotRelevance(store, snapshotId, [fileId]); // seeded over symmetrized edges
snapshotSymbolCoupling(store, snapshotId); // symbol pairs co-imported by 2+ files
```

The pure `computePageRank`, `computeRelevance`, `computeSymbolConsumers`, and
`computeSymbolCoupling` take node and edge arrays instead of a store.

## Git history

Ported in TP-126, strictly as codewatch had it: churn over rolling windows, first-seen dates,
ownership and bus factor, and change coupling. The engine lives in `src/history/` and is
published on its own subpath. Its API is path-based: repo-relative posix paths in, plain
records out, no node ids or snapshots.

```ts
import { computeChangeCoupling, couplingFor, loadChurnEntries } from "@titan-design/code-graph/history";

const entries = loadChurnEntries({ repoRoot: ".", windowDays: 90 }) ?? []; // null outside git
const { pairs, skippedLargeCommits } = computeChangeCoupling(entries);
couplingFor(pairs, "packages/code-graph/src/indexer.ts"); // partners by co-edit count
```

`indexPaths` writes history metrics on file nodes by default, through the
`history-metrics.ts` adapter, with codewatch's names: `churn_{w}`, `churn_{w}_commits`,
`churn_{w}_authors` and `recency_{w}` for each window, `file_age_days`, and `bus_factor_{w}`
plus `top_author_share_{w}` for the primary window. Windows default to 30, 90 and 180 days
plus `churnWindowDays` (the primary, default 30); `churnWindows` replaces the defaults and
`lifetime: true` adds an all-history window with its own ownership. `computeChurn: false`
turns all of it off. Outside git, or without a git binary, the index simply has no history
metrics.

Change coupling is not stored. It is computed on demand from `loadChurnEntries`, as
codewatch's `graph coupled` command did.

**The seam.** Nothing under `src/history/` imports the rest of code-graph; the rest may import
it. The `code-graph-history-seam` rule in `.codewatch/check.json` fails `pnpm dag:check` on
any such import. That keeps a later extraction into `@titan-design/git-history` a directory
move plus an import-path change.

**Behaviour kept from codewatch, gaps included.** A rename is followed only inside the commit
that made it, so a file's churn before the rename stays on its old path and is dropped.
First-seen dates come from a separate `--no-renames` pass, which makes a renamed file look
younger. `--since` resolves against git's clock while window slicing uses `nowEpoch`. History
metrics are recomputed on every index and never carried forward under reuse.

## Test linking and coverage

Ported in TP-133, strictly as codewatch had it. `linkTestsToSources` pairs each test file
with non-test files in two passes. Pass 1 uses path conventions: it strips a `.test` or `.spec`
infix and collapses a `__tests__/`, `test/` or `tests/` segment. Pass 2 gives a test that
pass 1 left unpaired its strongest co-edited non-test partner, with at least 2 shared commits.

`indexPaths` writes `linked_test_count` on each linked source, with or without git. With git
history on it also writes `test_bus_factor_{w}` and `test_top_author_share_{w}` for the
primary window. These summarize churn authorship across all tests linked to a source, so a
file can be well spread in production code and a single-author silo in its tests. All three
are recomputed on every index and never carried forward.

`computeTestCoverageOwnership` lives in the `history-metrics.ts` adapter, not in
`src/history/`. It needs test links, and the seam forbids history from importing them.

```ts
import { attributeCoverage } from "@titan-design/code-graph";

// fileIdOf maps an absolute path to a file id, or null to skip; spans come from symbol nodes' attrs.
const metrics = attributeCoverage(istanbulReport, fileIdOf, symbolSpansByFile);
```

`attributeCoverage` turns an Istanbul `coverage-final.json` into `coverage_pct` metrics: one
per file (covered functions over total functions) and one per symbol, matched by line-range
containment to the innermost symbol. Coverage depends on which tests ran, not on file bytes,
so the index never writes or carries it. The caller stores it on the snapshot it measured,
as codewatch's `graph coverage` command does.
