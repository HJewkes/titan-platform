# code-graph

**Tier 2 · domain.** Depends on [`store-sqlite`](/reference/store-sqlite),
[`code-parser`](/reference/code-parser), [`embed`](/reference/embed),
[`retrieval`](/reference/retrieval), and `ts-morph`.

```sh
npm install @titan-design/code-graph
```

## The problem it solves

Architectural questions — what imports this, is this dead, does this module reach across a
layer — need the dependency graph of a source tree, and building one that is both accurate
and fast to refresh is a project of its own.

This is the graph: files, modules, exported and internal symbols, external packages, and the
import / re-export / reference edges between them, with source metrics computed at index
time, in one SQLite file, refreshed incrementally.

## When to reach for it

You are writing a tool that reasons about code structure: a layering check, a dead-code
report, an impact analysis, a code-aware retrieval index. TypeScript, TSX, and Python.

This repo's own `pnpm dag:check` runs on its graph, through codewatch's CLI.
`scripts/dag-check-self.mjs` runs the same check on this package's own rules engine.

## Example

Verified against 0.1.0, indexing this repo's `packages/registry/src`.

```ts
import { indexPaths, listEdges, listNodes, openCodeGraph } from "@titan-design/code-graph";

const store = openCodeGraph(".codewatch/graph.db");

const { snapshotId, files, nodes, edges, reused } = await indexPaths(store, {
  paths: ["packages/registry/src"],
  ref: "head",
});
// { files: 14, nodes: 77, edges: 84, reused: 0 }

listNodes(store, snapshotId);
// [ { kind: 'external', id: 'npm:vitest' },
//   { kind: 'external', id: 'npm:zod' },
//   { kind: 'module',   id: 'packages/registry/src/cli-options.test' }, … ]

listEdges(store, snapshotId);
// [ { kind: 'imports', srcId: 'packages/registry/src/cli-options.test.ts', dstId: 'npm:vitest' }, … ]
```

`paths` are resolved against the process working directory; pass absolute paths if you run
from elsewhere. There is no `cwd` option.

## Checking a snapshot

The rules engine turns a snapshot into pass/fail against a `check.json`. Verified against
this release, checking `packages/code-graph/src` at `head` against itself at `main`, with one
tightened rule:

```ts
import { checkSnapshot, loadCheckRules, validateRules } from "@titan-design/code-graph";

const rules = await loadCheckRules(".codewatch/check.json", { onWarn: console.warn });
checkSnapshot(store, { snapshot: "head", baseline: "main", rules }).result;
// { rulesEvaluated: 4, nodesEvaluated: 144, newErrors: 0, carryoverErrors: 0, passed: true, … }

const tight = validateRules({
  rules: [{ id: "max-loc", type: "metric-max", metric: "loc", kind: "file", max: 200, excludeRoles: ["test"] }],
});
checkSnapshot(store, { snapshot: "head", baseline: "main", rules: tight }).result.violations;
// [ { nodeId: 'packages/code-graph/src/check/validate.ts', message: 'loc=222 > 200' },
//   { nodeId: 'packages/code-graph/src/extractors/ts-morph-extractor.ts', message: 'loc=275 > 200', isCarryover: true }, … ]
// newErrors: 1, carryoverErrors: 4, passed: false
```

Six rule types came from codewatch: `metric-max`, `metric-min`, `metric-product-max`,
`forbid-import`, `layered-deps` (layers are path prefixes; an import may point only to its
own layer or a lower one), and `no-internal-only-barrels`. A seventh, `metric-outlier`, flags
nodes of one `kind` strictly above a `percentile` (50 to 100) of a metric over that kind in the
snapshot, once `minSample` nodes (default 20) carry it. Severity defaults to `error`.

`snapshot` and `baseline` take a numeric id or a ref name, and a ref resolves to its newest
snapshot. `runChecks(store, { snapshotId, rules, baselineSnapshotId })` is the same engine on
ids.

**The baseline is a ratchet.** A violation whose key (rule id, node id, and destination id
for edge rules) also fires on the baseline is marked `isCarryover`. Only new errors set
`passed: false`, so existing debt never blocks a change and new debt always does. The
baseline's node ids are carried through the alias chain into the checked snapshot first, so a
moved file's violations carry over instead of reading as one resolved plus one new. Unmoved
ids key exactly as before, so baselines from older builds still match.

**Symbol rules.** A metric rule with `kind: "symbol"` evaluates the symbol layer, so
`symbol_cyclomatic` and `symbol_cognitive` rules fire per function. A rule without `kind`
stays on the file graph, so existing baselines do not change. Before this release symbol
rules never fired (TP-251): the rule context read `listNodes` without `includeSymbols`.

**Findings.** Metric violations carry `path` (a symbol's parent file), `lineStart`,
`lineEnd`, `symbol`, `evidence` (`symbol_cyclomatic=14 (max 10)`) and `tool`.
`toFindings(result)` turns a `CheckResult` into tool-neutral `Finding` records whose `id`
keys on the node id, so an id survives code moving above it. `externalToFinding({ tool,
rule, file, line, endLine, message, severity })` maps another linter's diagnostic, such as
style-checker's ruff output, onto the same shape without importing that linter.

**Stored findings and verdicts.** `Finding.id` is not unique: an external tool's id embeds
its line number, and two diagnostics on one line share it. Stored findings key on
`findingKey` instead: tool, signal, the innermost symbol node id (or the path), a hash of
the whitespace-normalized flagged text, and a collision ordinal. An inserted line above the
finding keeps its key. `keyFindings(inputs)` numbers collisions in source order, so input
order does not change a key.

```ts
const stored = keyFindings(findings.map((finding) => ({ finding, anchor, flaggedText, excerptHash })));
saveFindings(store, snapshotId, stored);
saveVerdicts(store, snapshotId, verdicts); // { key, verdict, rationale, citations, excerptHash, model?, ... }
carryForwardVerdicts(store, previousSnapshotId, snapshotId); // count copied
```

`carryForwardVerdicts` copies a verdict only when the target snapshot has a finding with the
same key and the same excerpt hash as the one the verdict judged, so a change anywhere in
the shown excerpt forces a fresh judgement. Both tables are snapshot-scoped and pruned with
their snapshot. The schema moved to version 4 with no `INDEX_VERSION` bump; an older build
refuses a database this build opened.

## Diffing two snapshots

```ts
import { diffCheckResults, diffSnapshots } from "@titan-design/code-graph";

diffSnapshots(store, { fromSnapshotId: 1, toSnapshotId: 2 }).summary;
// { addedNodes: 36, removedNodes: 0, renamedNodes: 0, unchangedNodes: 108,
//   addedEdges: 77, removedEdges: 0, metricChanges: 20, … }

diffCheckResults(store, { fromSnapshotId: 1, toSnapshotId: 2, rules: tight }).newViolations;
// [ { nodeId: 'packages/code-graph/src/check/validate.ts', … } ]
```

`diffSnapshots` reports metric deltas only on nodes present in both snapshots. Ids follow the
alias chain between the two snapshots, across every rename in between, so a move is a rename
rather than a delete plus an add, and its edges do not churn. `diffCheckResults` buckets violations as
new, resolved, or unchanged, and splits unchanged metric violations into worsened and
improved by value.

## Finding similar symbols

"Does something like this already exist?" Ported from codewatch (TP-129). Verified against
this release with Ollama's `nomic-embed-text`, indexing this repo's `packages`:

```ts
import { OllamaEmbedder } from "@titan-design/embed";
import { findSimilarCapability, tryEmbedSnapshot } from "@titan-design/code-graph";

const embedder = new OllamaEmbedder();
await tryEmbedSnapshot(store, snapshotId, embedder);
// { ok: true, result: { symbols: 1196, withPurpose: 429, newlyEmbedded: 1191, reused: 0, … } }
// a second run: { newlyEmbedded: 0, reused: 1196 }

await findSimilarCapability(store, snapshotId, "fuse ranked lists with reciprocal rank fusion", embedder);
// { coverage: { symbols: 1196, embedded: 1196, withPurpose: 429 },
//   candidates: [ { id: 'packages/retrieval/src/fusion.ts#fuseByRRF', score: 0.819 },
//                 { id: 'packages/retrieval/src/engine.ts#createRetrievalEngine', score: 0.599 }, … ] }
```

The embedded text per symbol is its signature plus its docstring, never its body. Vectors live
in `blob_cache`, keyed by model and text hash rather than snapshot, so unchanged text is never
re-embedded. `tryEmbedSnapshot` reports a down backend instead of throwing. Results are
candidates with scores and a coverage figure, never verdicts.

**Prefixes belong to the embedder and are part of the cache key.** Symbol texts are embedded
with role `document` and the query with role `query`, so a default nomic embedder sends
`search_document: ` and `search_query: `, one prefix per text. `embedder.model` includes a
hash of the prefix table, so vectors made under two prefix configurations never share a
`blob_cache` key. Python symbols carry no signature yet, so they are not searchable.

## Graph analyses

Dead-code and growth-risk metrics land at index time, beside the source metrics, and carry
forward for unchanged files. PageRank, relevance, and symbol coupling run at query time.
Verified against this release, indexing this repo's `packages/`:

```ts
import {
  snapshotPageRank,
  snapshotRelevance,
  snapshotSymbolConsumers,
  snapshotSymbolCoupling,
} from "@titan-design/code-graph";

snapshotPageRank(store, snapshotId).rows.slice(0, 2);
// [ { nodeId: 'npm:zod', score: 0.0335 }, { nodeId: 'npm:vitest', score: 0.0225 } ]

snapshotRelevance(store, snapshotId, ["packages/registry/src/index.ts"]);
// Map { 'packages/registry/src/index.ts' => 0.182, 'packages/registry/src/types.ts' => 0.080,
//       'npm:zod' => 0.062, 'packages/registry/src/invoke.ts' => 0.046, … }

snapshotSymbolCoupling(store, snapshotId)[0];
// { aName: 'GraphEdge', bName: 'GraphNode', coImports: 15, crossFile: false, … }

snapshotSymbolConsumers(store, snapshotId)[0];
// { symbolId: 'packages/code-graph/src/types.ts#GraphNode', consumers: [ …21 files ] }
```

`snapshotPageRank` reads the file-level graph (no symbols, no `references` edges). Pass
`personalization` to seed it toward target ids, which is what codewatch's `graph relevant`
does. `snapshotRelevance` is the seeded variant over symmetrized edges that `graph context`
uses, so relevance reaches a target's importers as well as its imports.

The index-time metrics, all sparse (a row only when above zero):

| Metric | Languages | Counts |
| --- | --- | --- |
| `unreachable_statements` | TypeScript | statements after a `return`, `throw`, `break` or `continue` in the same block |
| `unused_locals` | TypeScript | plain-identifier locals never referenced in their function |
| `unused_params` | TypeScript | the trailing run of unused plain parameters |
| `loop_depth` | TypeScript, Python | deepest lexical loop nesting, emitted at 2 or more |
| `recursive_functions` | TypeScript | named functions that call themselves by name |
| `search_in_loop` | TypeScript | `.includes`, `.find`, `.filter` and similar inside a loop |

Growth-risk metrics are smells, not complexity bounds: `.includes` on a `Set` is O(1), and
two nested loops over different collections are linear.

## Partition quality

Scores a package partition of the file graph. Verified against this release, over this
repo's `packages/` (26 packages, 659 files, 1,706 package-to-package edges):

```ts
import { computePartitionQuality, invertBuckets } from "@titan-design/code-graph";

const { modularityQ, perPackage, pairCoupling, flagsCount } = computePartitionQuality({
  packages, // [{ id: "packages/code-graph" }, …]
  fileByPackage, // Map { "packages/code-graph" => ["packages/code-graph/src/store.ts", …] }
  nodes,
  edges,
});

modularityQ; // 0.774 — Newman-Girvan Q over the package partition
perPackage.find((p) => p.pkgId === "packages/store-sqlite");
// { fileCount: 20, cohesion: 1, instability: 0, abstractness: 0, layer: 'foundation', flags: [] }
perPackage.find((p) => p.pkgId === "packages/code-read");
// { fileCount: 44, cohesion: 0.87, instability: 1, abstractness: 0, layer: 'top', flags: [] }
pairCoupling.filter((p) => p.flag === "tight");
// [ { from: 'packages/rpc-client', to: 'packages/rpc-protocol', edges: 14, intensity: 0.67, … }, … ]
flagsCount; // 3
```

`cohesion` is internal over internal-plus-outgoing edges, `instability` is Martin's I, and
`abstractness` is the share of the package's files with `role: "types"` — a file-level proxy
for Martin's A, since there are no symbol-level abstract counts. `layer` is read off
instability: `foundation` at 0.3 or below, `top` at 0.9 or above, `middle` between.
`weak-boundary` flags a non-top package whose cohesion is under 0.5. Pair `intensity` is
`edges / files(from)`: `tight` at 0.6 or above, `moderate` at 0.3.

`resolveBarrels: true` rewrites an edge landing on a `role: "barrel"` file onto the files it
re-exports, transitively. It over-attributes — one import of one name becomes one edge per
re-export target — so it is off by default. On this repo it takes Q from 0.774 to 0.292.

`invertBuckets(fileByPackage)` is the file-id-to-package-id lookup the same callers need,
skipping the `""` unassigned bucket.

## Pruning snapshots

```ts
import { planPrune, runPrune } from "@titan-design/code-graph";

planPrune(store, { keep: 10, keepRefs: ["main"] });
// { keep: [ …10 newest plus every snapshot on main… ], remove: [ … ] }

runPrune(store, { keep: 2, vacuum: true });
// { plan, rowsBefore: { snapshot: 5, node: 25615, edge: 25115, metric: 90955, id_alias: 0 },
//   rowsAfter:  { snapshot: 2, node: 10246, edge: 10046, metric: 36382, id_alias: 0 }, vacuumed: true }
```

The domain tables declare no foreign key, so `CodeGraphStore.deleteSnapshots` clears every
table in `SNAPSHOT_SCOPED_TABLES` itself instead of relying on a cascade. `blob_cache` is
content-addressed rather than snapshot-scoped, so a prune never drops a cached embedding.

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

## The id scheme

File, module and external ids are preserved exactly from codewatch, because this repo's
`dag:check` consumes them. Symbol ids diverge from codewatch since index version 0.14.0:

- A **file** id is its path relative to the git toplevel, in posix form:
  `packages/registry/src/index.ts`. Ids root at the git toplevel even when you walk a
  subtree, so importers across subtrees share one id space.
- A **module** id is the file id minus its extension. Its parent is the directory above it.
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

Every run writes a fingerprint per file: a content hash, and a comment/whitespace-insensitive
hash of its parse structure. The next run diffs against the most recent snapshot carrying the
same `INDEX_VERSION`. That version is bumped whenever a metric can change for the same bytes,
not only when the node or edge shape changes. 0.12.0 marks `.tsx` files moving to the tsx
grammar (TP-166); 0.13.0 marks the dead-code and growth-risk metrics joining the carry-forward
set (TP-127); 0.14.0 marks symbol ids qualified by their enclosing scopes (TP-182); 0.15.0
marks symbol aliases on a file rename and the recorded alias base (TP-187). A snapshot from an
older version is never reused, so the first run after an upgrade is a full index. The first 0.14.0 run after an older snapshot
writes `requalify` id aliases from each bare-name id to its qualified successor, only where
exactly one declaration in the file carries that name.

| Tier | Trigger | Work skipped |
| --- | --- | --- |
| reuse | content hash matches | parse and extract both; nodes, edges and source metrics carried forward verbatim |
| cosmetic | content changed, structural hash matches | the ts-morph extract; edges come from the basis, symbol line spans refreshed from the fresh parse |
| full | structural hash changed, or the file is new | nothing |

A file-membership delta (a file added or removed) forces the files whose imports it
re-resolves back to full extraction even when they are byte-identical. Degree metrics are
always recomputed over the whole assembled graph, so a heavily-reused run and an
`incremental: false` run produce the same snapshot — `indexer.test.ts` asserts that.

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

**The adapter is a root export, not a `./history` one.** A product that runs its own indexing
pass needs the same `GraphMetric` rows `indexPaths` writes, and `./history` may not speak
graph types:

```ts
import { DEFAULT_CHURN_WINDOWS, loadHistoryMetrics, windowSuffix } from "@titan-design/code-graph";

const loaded = loadHistoryMetrics(nodes, repoRoot, { churnWindowDays: 30, includeLifetime: true });
// null outside git; otherwise { metrics: GraphMetric[], primaryEntries: ChurnEntry[] }
loaded?.metrics.filter((m) => m.name === `churn_${windowSuffix(30)}`); // churn_30d
DEFAULT_CHURN_WINDOWS; // [30, 90, 180]
```

`primaryEntries` are the churn entries inside the primary window, which is what
`computeTestCoverageOwnership` needs and what saves a caller a second git pass.
`resolveChurnWindows` and `computeRecencyWindows` are exported beside them. Node ids are the
history engine's repo-relative paths, so `nodes` and `repoRoot` must share a root.

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

## Reading one node or one metric

Added for the read API (TP-183). Verified against this repo's `packages/` tree (547 files,
27,103 metric rows):

```ts
import { aggregateMetrics, describeMetric, listEdgesTouching, listMetricsForNode } from "@titan-design/code-graph";

listMetricsForNode(store, snapshotId, "packages/registry/src/invoke.ts");
// [ { name: 'churn_30d', value: 44, unit: 'lines' }, { name: 'fan_in', value: 2, … }, { name: 'loc', value: 38, … }, … ]

listEdgesTouching(store, snapshotId, "packages/registry/src/invoke.ts");
// 5 edges, in and out: [ { srcId: '…/invoke.ts', dstId: 'npm:zod', kind: 'imports' }, … ]

aggregateMetrics(store, snapshotId, { name: "loc" });
// [ { name: 'loc', nodeKind: 'file', count: 547, sum: 50136, min: 1, max: 1038 } ]

describeMetric("churn_90d");
// { name: 'churn_90d', unit: 'lines', appliesTo: ['file'], rollup: 'sum', direction: 'neutral',
//   absent: 'zero', source: 'history', window: '90d', description: 'Lines added plus deleted in the 90d window.' }
```

The three reads are index searches, with no new index or migration. On that tree,
`listMetricsForNode` takes 0.014 ms against 9.7 ms for `listMetrics` filtered to the node,
and `listEdgesTouching` takes 0.03 to 0.08 ms against 2.0 ms for `listEdges` filtered.
`listEdgesTouching` hides `references` and `calls` edges unless you pass `includeReferences`, as
`listEdges` does.

Three more reads answer a report's questions on the same indexes, over this repo's
`packages/` snapshot:

```ts
store.listMetricNames(snapshotId);
// 20 names: [ 'class_count', 'cognitive_max', 'cognitive_sum', 'cyclomatic_max', … ]

store.topByMetric({ snapshotId, metric: "loc", kind: "file", limit: 3 });
// [ { nodeId: 'packages/code-graph/src/check/check.test.ts', name: 'check.test.ts',
//     kind: 'file', role: 'test', value: 1038, unit: 'lines' }, … ]

store.replaceMetricsByName(snapshotId, "coverage_pct", metrics); // one transaction, no stale rows
```

`replaceMetricsByName` is the write an overlay needs: coverage is re-ingested wholesale, and
inserting without deleting would leave rows for symbols that no longer exist.

`METRIC_CATALOGUE` describes every metric name the package writes: unit, node kinds, rollup
rule, direction, what a missing row means, and the writing module. Windowed names such as
`churn_{w}` are templates, and `describeMetric` resolves a stored name to a concrete
descriptor. A `rollup` of `none` means no rollup reproduces the group's own value, so a
reader must not synthesize one. A test indexes a fixture repo and fails on any stored metric
name without a descriptor.

## Gotchas

**A database from a newer build is refused.** `openCodeGraph` throws `SchemaTooNewError`
when the stored migration version exceeds `SCHEMA_VERSION`. A code graph database belongs to
one build, so a higher version means a newer one already moved the schema and this build
would query columns that are gone.

**Workspace imports need the target package built.** An import of a workspace package by its
published name resolves to that package's *source* file, not to an `npm:` external, by
remapping the `dist/*.d.ts` entry ts-morph resolves back onto `src/`. That remap needs the
dist to exist, which is why `pnpm build` precedes both `pnpm test` and `dag:check` here.

**The symbol layer is hidden by default.** `listNodes` drops `symbol` nodes and `listEdges`
drops `references` and `calls` edges unless you ask for them, so a caller reasoning about module
structure does not have one import of thirty names read as thirty dependencies.

**Snapshots, not intervals.** The domain `edge` table here is snapshot-scoped, keyed
`(snapshot_id, src_id, dst_id, kind)`. `store-sqlite`'s own edge table is bi-temporal, which
is the wrong time model for a population re-indexed all at once. See
[Architecture](/guides/architecture#two-time-models-on-purpose).

**Deprecated names in a rules file heal, they do not fail.** A metric spelled `lines` or a
role spelled `tests` loads as `loc` or `test` and reports through `onWarn`. An unknown role
still throws.

**Python support is narrower than TypeScript.** It is new here rather than ported: no type
checker, so imports resolve by dotted path against the tree, and symbols come from the same
tree-sitter declaration walk that feeds complexity.

## What was deliberately left in codewatch

The product surfaces: the CLI commands, the `claude -p` summarizer that `summarizeConventions`
is handed, and the MCP and read-API wiring. The rules engine, the snapshot diff, git history
(churn, ownership, change coupling), symbol embeddings, dead code, growth risk, PageRank,
relevance, symbol coupling, test linking, the coverage overlay, partition quality, snapshot
pruning, communities, and conventions started there and have since been ported.

## Where it came from

codewatch's `@codewatch/graph`, split along the seam the audit identified: that package was
doing the job of both a store and a code graph. The store half became
[`store-sqlite`](/reference/store-sqlite).
