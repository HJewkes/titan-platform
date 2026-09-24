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
listEdges(store, snapshotId); // imports / re-exports, references and calls on request
```

## What was extracted, and what was not

In: the parser (tree-sitter WASM for TypeScript, TSX and Python, since moved to
`@titan-design/code-parser` and still re-exported here), the walk, the ts-morph
extractor and its symbol layer, role classification, generated-file detection, id aliasing
across git renames, the three-tier incremental reuse, and the metrics computed at index time
(degree, utilization, loc, cyclomatic, cognitive, nesting, class count, lcom4, and per
symbol `symbol_cognitive`, `symbol_cyclomatic`, `symbol_loc`, `symbol_max_nesting`, and the
comment and shape metrics below). `lcom.ts` came along despite being an analysis: `source-metrics.ts` calls it
directly and lcom4 is a pure function of a file's bytes, so it belongs with the metrics that
carry forward under reuse.

Ported later (TP-123, TP-124), strictly as codewatch had them: the rules engine
(`check*.ts`, now `src/check/`) and the snapshot diff plus check diff (`diff.ts`,
`check-diff.ts`, now `src/diff/`). See [Checks and diffs](#checks-and-diffs).
Ported with TP-127 and TP-128: dead code, growth risk, PageRank, relevance, and symbol
coupling, now `src/analysis/`. See [Graph analyses](#graph-analyses).
Ported with TP-133: the test linker and the Istanbul coverage overlay, also in `src/analysis/`,
and test-coverage ownership. See [Test linking and coverage](#test-linking-and-coverage).

Ported with TP-250: package partition quality (`src/analysis/partition-quality.ts`) and
snapshot pruning (`src/prune.ts`). See [Partition quality](#partition-quality) and
[Pruning snapshots](#pruning-snapshots).

Ported with TP-130: community detection and the convention layer (`src/conventions/`). See
[Conventions](#conventions). codewatch keeps the CLI command, the `claude -p` summarizer, and
the MCP and read-API wiring.

Deferred, still in codewatch, a follow-up on this package rather than a change to it:

- Reuse-delta reporting over a finished snapshot.

Python support is new here rather than ported. codewatch walked TypeScript only; the parser
already had the grammar. The Python extractor is deliberately narrower than the ts-morph one:
no type checker, so imports resolve by dotted path against the tree and symbols come from the
same tree-sitter declaration walk that feeds complexity.

## The id scheme

File, module and external ids are preserved exactly from codewatch, because this repo's own
`dag:check` consumes them through codewatch's CLI. Symbol ids diverge from codewatch since
index version 0.14.0:

- A **file** id is its path relative to the git toplevel, in posix form:
  `packages/registry/src/index.ts`. Ids root at the git toplevel even when you walk a
  subtree, so importers across subtrees share one id space.
- A **module** id is the file id minus its extension: `packages/registry/src/index`. Its
  parent is the directory above it.
- A **symbol** id hangs under its declaring file as `<fileId>#<qualifiedName>`, split on the
  first `#`. A top-level declaration's qualified name is its own name
  (`src/a.ts#createThing`). A member or nested declaration is prefixed by its enclosing named
  scopes, joined with `.`: `src/a.ts#Job.run`, `src/a.ts#outer.helper`, and
  `src/a.ts#handlers.onClick` for a method of `const handlers = {…}`. Anonymous scopes, such
  as a callback argument or an unbound class expression, add no segment, so ids do not depend
  on declaration order. One scope binds a name once: a getter/setter pair, a Python property's
  accessors, and overloads each share one node. Index versions before 0.14.0 keyed members by
  bare name, so same-named methods in one file collapsed into one node (TP-182).
- An **external** id is `npm:<package>` (scope-aware) or the `node:` builtin verbatim.

`NodeKind`, `EdgeKind`, and the `role` vocabulary are unchanged. So is the property the DAG
check rests on: an import of a workspace package by its published name resolves to that
package's source file, not to an `npm:` external, by remapping the `dist/*.d.ts` entry
ts-morph resolves back onto `src/`. That remap needs the target package built, which is why
`pnpm build` precedes both `pnpm test` and `dag:check`.

## Identity across renames

Added in index version 0.15.0 (TP-187). Git rename detection writes `id_alias` rows mapping a
file's and its module's old id to the new one. A file rename also writes an alias for every
symbol present on both sides, so `a.ts#Job.run` follows `a.ts` to `b.ts#Job.run`. A symbol
renamed inside a file is not followed.

Each snapshot records its alias base in `attrs.aliasBase`: the snapshot whose commit its
aliases were computed against. A new index of a ref diffs against that ref's newest committed
snapshot, falling back to the newest committed snapshot of any ref. The bases form a tree, so
ids can be carried between any two snapshots that share an ancestor, forward or backward.

```ts
import { aliasChain, priorSnapshotForRef, resolveAlias } from "@titan-design/code-graph";

resolveAlias(store, "src/job.ts", 4, { fromSnapshotId: 1 });
// { id: 'core/worker.ts', reason: 'move',
//   hops: [ src/job.ts -> src/task.ts, src/task.ts -> src/worker.ts, src/worker.ts -> core/worker.ts ] }
resolveAlias(store, "src/job.ts#Job.run", 4, { fromSnapshotId: 1 }).id; // 'core/worker.ts#Job.run'
aliasChain(store, 1, 4).resolve; // one resolver for many ids
priorSnapshotForRef(store, "main", { before: 7, repoRoot: "." }); // the snapshot main denotes
```

Without `fromSnapshotId`, `resolveAlias` walks from the root of the target's lineage, so an id
from any ancestor resolves. Each snapshot's aliases are applied once, in order: they come from
one git diff, so `a.ts` to `b.ts` plus `b.ts` to `a.ts` in one snapshot is a swap, not a
cycle. Walks stop after 10,000 snapshots. Two snapshots with no common base fall back to the
to-snapshot's own aliases, which is what `diffSnapshots` did before 0.15.0.

`priorSnapshotForRef` prefers the snapshot of the commit git resolves the ref to, and
otherwise the newest snapshot labelled with that ref. A snapshot written before 0.15.0 records
no base; its base is inferred as the newest earlier snapshot with a commit, which is the one
the 0.14.0 indexer diffed against. Nothing is written on read, so a 0.14.0 store opened
read-only diffs and checks across renames too.

## The three reuse tiers

Every run writes a fingerprint per file: a content hash and a comment/whitespace-insensitive
hash of its parse structure. The next run diffs against the most recent snapshot carrying the
same `INDEX_VERSION` and sorts each file into one tier. `INDEX_VERSION` is bumped whenever a
metric can change for the same bytes, not only when the node or edge shape changes: 0.12.0
marks `.tsx` files moving to the tsx grammar, which changed their complexity metrics and
symbol spans; 0.13.0 marks the dead-code and growth-risk metrics joining the carry-forward set;
0.14.0 marks symbol ids qualified by their enclosing scopes (TP-182); 0.15.0 marks symbol
aliases on a file rename and the recorded alias base (TP-187). A snapshot from an older version
is never reused, so the first run after an upgrade is a full index. The first 0.14.0 run after
an older snapshot writes `requalify` id aliases from each bare-name id to its qualified
successor, only where exactly one declaration in the file carries that name.

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

`openCodeGraph` opens the database with the kit's pragmas and runs four migrations.

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
`file_fingerprint`. Migration 4 adds `finding` and `verdict`, both keyed
`(snapshot_id, key)` on a `findingKey` and pruned with their snapshot.

The symbol layer is hidden by default. `listNodes` drops `symbol` nodes and `listEdges` drops
`references` and `calls` edges unless you ask for them (`includeReferences` covers both), so a caller reasoning about module structure sees
the graph it expects and does not have one import of thirty names read as thirty
dependencies.

## Targeted reads and the metric catalogue

Added for the read API (TP-183). Three store reads answer one node or one metric without
loading a snapshot, and a catalogue describes every metric name the package writes.

```ts
import { aggregateMetrics, describeMetric, listEdgesTouching, listMetricsForNode } from "@titan-design/code-graph";

listMetricsForNode(store, snapshotId, "packages/registry/src/invoke.ts"); // every metric on one node
listEdgesTouching(store, snapshotId, "packages/registry/src/invoke.ts"); // edges in and out; references on request
aggregateMetrics(store, snapshotId, { name: "loc" }); // [{ name: "loc", nodeKind: "file", count, sum, min, max }]
describeMetric("churn_90d"); // { unit: "lines", rollup: "sum", direction: "neutral", absent: "zero", window: "90d", … }
```

Three more store reads answer a report's questions without loading a snapshot:
`listMetricNames(snapshotId)` for the distinct names stored, `topByMetric({ snapshotId,
metric, limit, kind })` for the highest-valued nodes joined to their kind and role, and
`replaceMetricsByName(snapshotId, name, metrics)`, which swaps one metric's whole row set in
a single transaction so a re-ingested overlay such as coverage never accumulates stale rows.

`computeDeepAst({ filePath, absPath, symbolName })` reads structure too heavy to persist
(params, return type, class members) from the working tree on demand, and returns null when
the file is unreadable.

- **Reads.** `listMetricsForNode` searches the metric primary key, `listEdgesTouching` the edge
  primary key plus `idx_edge_dst`, and `aggregateMetrics` `idx_metric_name`. None scans a
  table, and no index or migration was added, so any existing store serves them. A self-loop
  comes back once. `aggregateMetrics` groups by metric name and node kind, because
  `utilization` and the degree metrics sit on several kinds; `count` skips null values.
- **Catalogue.** `METRIC_CATALOGUE` holds one `MetricDescriptor` per name: `unit`,
  `appliesTo` (node kinds), `rollup` (`sum`, `max`, `mean`, or `none`), `direction`
  (`higher-worse`, `lower-worse`, or `neutral`), `absent`, `source`, and `description`.
  Windowed names are templates such as `churn_{w}`; `describeMetric` resolves a stored name
  such as `churn_90d` or `test_bus_factor_lifetime` to a concrete descriptor, and returns
  null for a name nothing writes.
- **`rollup: "none"`** means no rollup reproduces the group's own value. Summing fan-in counts
  a directory's internal edges, and summing per-file commit counts counts a shared commit
  more than once. A reader must not synthesize those.
- **`absent`** says what a missing row means. `zero`: the writer is sparse, so count the node
  as zero (dead code, growth risk, churn, `linked_test_count`). `exclude`: the metric does not
  apply or was not measured (a max over no functions, `coverage_pct` before ingest), so leave
  the node out of means, percentiles, and ranks.
- **Completeness is tested.** `catalogue-completeness.test.ts` indexes a fixture repo with
  history and a coverage overlay, and fails, naming the metric, when a stored name has no
  descriptor, when a descriptor's unit or node kinds disagree with the rows, or when a
  descriptor matches nothing.
- **Browser-safe.** The catalogue imports only `types.ts`. The `code-graph-catalogue-pure`
  and `code-graph-catalogue-no-node` rules in `.codewatch/check.json` hold it there, so a
  later browser subpath can re-export it. It ships from the root export today, which does
  pull in Node.

## Checks and diffs

The rules engine turns a snapshot into pass/fail against a `check.json`. Seven rule types:
`metric-max`, `metric-min`, `metric-product-max`, `metric-outlier`, `forbid-import`,
`layered-deps`, and `no-internal-only-barrels`. Severity defaults to `error`; only new errors
fail a check.

`metric-outlier` takes its threshold from the snapshot instead of the rule:
`{ "type": "metric-outlier", "id": "long-fn", "metric": "symbol_body_lines", "kind": "symbol", "percentile": 95 }`
flags every symbol strictly above the 95th percentile of `symbol_body_lines` over all symbols
that carry it, interpolated linearly between ranks. `percentile` runs from 50 to 100. The rule
stays silent until `minSample` nodes (default 20) carry the metric. Each violation's
`threshold` is the computed percentile value. For sparse metrics whose percentile sits at or
near zero, `floor` flags a node only if its value also exceeds that absolute number, and
`rankNonZero: true` ranks and gates on non-zero carriers only.

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
carryover, so existing debt does not block a change but new debt does. The baseline's node ids
are first carried through the alias chain into the checked snapshot (`rebasedViolationKey`),
so a moved file's violations carry over instead of reading as one resolved plus one new.
Unmoved ids key exactly as `violationKey` always did. Deprecated metric and
role spellings in a rules file (`lines`, `tests`) heal to their canonical names with a
warning through `onWarn` instead of failing validation.

`diffSnapshots(store, { fromSnapshotId, toSnapshotId })` reports added, removed and renamed
nodes, added and removed edges, and metric deltas on nodes present in both. Ids follow the
alias chain between the two snapshots, across every rename in between, so a move reads as a
rename rather than a delete plus an add, and its edges do not churn. Metric and edge-kind spellings are
canonicalised before comparing.

`diffCheckResults(store, { fromSnapshotId, toSnapshotId, rules })` runs the rules on both
snapshots and buckets each violation as new, resolved, or unchanged; unchanged metric
violations are further split into worsened and improved by value. From-side ids follow the
alias chain, as in the ratchet.

`scripts/dag-check-self.mjs` in the repo root runs this repo's DAG check on this engine
instead of codewatch's CLI.

The glob matching the rules use is exported too, because a CLI filters its own `--include`
and `--exclude` flags with the same semantics: `patternToRegex` (a `*` glob when the pattern
holds one, a case-sensitive substring otherwise), `compilePatterns`, and `matchesAny`.

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

- Dead code, TypeScript and Python: `unreachable_statements` (after a `return`, `throw` or
  `raise`, `break` or `continue` in the same block), `unused_locals`, and `unused_params`
  (trailing run only). Python skips `self`, `cls`, `_`-prefixed names, `global` and
  `nonlocal` names, and the parameters of stub bodies such as `@overload` signatures; a
  `*args` or `**kwargs` ends the trailing run.
- Growth risk, TypeScript and Python: `loop_depth` (at 2 or more), `recursive_functions`,
  and `search_in_loop` (`.includes`, `.find` and similar inside a loop). These are smells,
  not complexity bounds. Recursion and search match TypeScript call nodes only, so Python
  files get `loop_depth` alone, as in codewatch.

Comment, shape, and exception-handling metrics (TP-322) are also source-local, TypeScript and
Python, and are written on every function or file, zeros included:

- Per symbol: `symbol_comment_lines` (rows holding a comment inside the function, docstring
  excluded), `symbol_docstring_lines` (the Python docstring, or a JSDoc block ending on the row
  above the declaration), `symbol_body_lines` (rows holding code), `symbol_comment_ratio`
  (comment lines over `max(body lines, 1)`), `symbol_narrating_comments` (comments whose words
  share at least 2 tokens, or half their tokens, with the identifiers of the statement they sit
  above or trail), and `symbol_pass_through` (1 when the body is one call that forwards every
  parameter, in order, as a bare argument, skipping a `self` or `cls` receiver; a function
  with no parameters is never one).
- Per file: `except_count` (Python `except` and TypeScript `catch` clauses), `except_density`
  (per 100 non-blank lines), and `swallowed_except` (handlers whose body is empty, `pass`,
  `...`, `continue`, a bare or `None`/`null`/`undefined` return, or one call to a logger,
  `print`, `warn` or `console`).

Call-graph metrics (TP-323) come from `calls` edges, one per caller and callee symbol, each
carrying the literal arguments of every call site in `attrs.sites`. TypeScript resolves a
call or `new` through the type checker to one in-repo declaration. Python resolves only a
bare name declared at module level in the same file, a bare name bound by `from <in-repo
module> import`, and `self.<name>()` to a method of the enclosing class or a base class
declared in the same file. Anything else is dropped, never guessed, and an edge whose target
has no symbol node is pruned. The caller is the enclosing function, method or class, or the
file for a module-level call. Each function, method and class gets `symbol_caller_count`
(distinct callers, recursion excluded) and `symbol_single_caller_helper` (1 when a
non-exported, non-dunder symbol has exactly one caller and it is a symbol). A callable with 2
or more resolved call sites also gets `symbol_constant_params`: parameters every site passes
the same literal, or none passes. Callers found only through unresolved calls are missing, so
a private method that tests call on an instance can read as a single-caller helper. These
metrics need edges from every file, so they are recomputed on each index. Under reuse, an
unchanged caller's edge to a callee that moved behind a re-export stays pruned until the
caller changes, as `references` edges do.

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

### Partition quality

`computePartitionQuality` scores a package partition of the file graph: per-package cohesion,
Martin instability, an abstractness proxy (the share of `role: "types"` files), a layer label
(`top`, `middle`, `foundation`), pair coupling by intensity (`edges / files(from)`), and a
Newman-Girvan modularity Q over the whole partition.

```ts
import { computePartitionQuality, invertBuckets } from "@titan-design/code-graph";

const result = computePartitionQuality({ packages, fileByPackage, nodes, edges });
result.modularityQ; // 0.77 on titan-platform's packages/*
invertBuckets(fileByPackage); // file id -> package id, skipping the "" unassigned bucket
```

`resolveBarrels: true` rewrites an edge landing on a `role: "barrel"` file to the files it
re-exports, transitively. It over-attributes: one import of one name through a barrel becomes
one edge per re-export target, which is why it is off by default.

### Pruning snapshots

`planPrune` keeps the most recent `keep` snapshots (default 10) plus every snapshot whose ref
is in `keepRefs`; `runPrune` deletes the rest and reports row counts before and after.

```ts
import { planPrune, runPrune } from "@titan-design/code-graph";

planPrune(store, { keep: 10, keepRefs: ["main"] }); // { keep, remove }
runPrune(store, { keep: 10, vacuum: true }); // { plan, rowsBefore, rowsAfter, vacuumed }
```

The domain tables declare no foreign key, so `CodeGraphStore.deleteSnapshots` clears each of
`SNAPSHOT_SCOPED_TABLES` itself rather than relying on a cascade. `blob_cache` is
content-addressed and not snapshot-scoped, so a prune never drops a cached embedding.

## Conventions

"How does this repo do X, and where does code like this belong?" Ported from codewatch's
unmerged C-88 branch (TP-130). The layer cuts the barrel-resolved file graph into a few coarse
areas, has an injected summarizer describe each one, and ranks areas against a question by
embedding similarity. Verified against this release on this repo's `packages/`, with a fake
summarizer:

```ts
import { findConventions, getConventionMap, summarizeConventions } from "@titan-design/code-graph";

const summarizer = { model: "claude:sonnet", summarize: (prompt: string) => callYourLlm(prompt) };
await summarizeConventions(store, snapshotId, summarizer);
// { coverage: { files: 713, grouped: 513, areas: 24, summarized: 24 }, newlySummarized: 24, reused: 0, … }
// a second run: { newlySummarized: 0, reused: 24 }

getConventionMap(store, snapshotId, "claude:sonnet"); // the same areas, stored summaries only
await findConventions(store, snapshotId, "how are CLI commands registered?", embedder, "claude:sonnet");
// { matches: [ { label, summary, files: [ …up to 5 ], size, score }, … up to 3 ] }
```

- **The cut.** `detectCommunities` is greedy modularity (Clauset-Newman-Moore), not Leiden. It
  is deterministic without a seed: ties resolve by sorted id. `targetCount` keeps merging past
  the natural modularity stop until that many communities remain, and a size cap of twice the
  ideal share keeps a dense repo from collapsing into one area. The default target is one area
  per 25 files, clamped to 6..40. Areas under `minSize` (default 3) files are left unsummarized.
  Disconnected components never merge, so the component count is the floor.
- **Only the coarse level is summarized.** LLM cost is one call per area, and each summary is
  stored in `blob_cache` under `code-graph/community-summary`, keyed by `summarizer.model` and a
  hash of the prompt. The prompt carries the member files and their key exported signatures, so
  an area whose membership and signatures did not change is a cache hit in any snapshot. On
  this repo a finer cut (`targetCount: 60`) still reused 8 of its 35 areas.
- **The package ships no LLM client.** `Summarizer` is `{ model, summarize(prompt) }`; the
  product supplies it. `getConventionMap` and `findConventions` never call it. `findConventions`
  throws when no summary is stored for the model, and returns candidates with scores, not
  verdicts. Summary vectors go through the same embedding cache as similar symbols.

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

The adapter is exported from the package root, not from `./history`, because it speaks
`GraphMetric` and the seam below does not. A product that indexes on its own terms calls
`loadHistoryMetrics(nodes, idRoot, options)` for both the metric rows and the primary-window
churn entries they were built from (`LoadedHistory`), with `HistoryMetricsOptions`,
`DEFAULT_CHURN_WINDOWS` (`[30, 90, 180]`), `resolveChurnWindows`, `windowSuffix` (`30d`,
`lifetime`) and `computeRecencyWindows` alongside it. Node ids are the history engine's
repo-relative paths, so both must be rooted at the same `idRoot`.

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
