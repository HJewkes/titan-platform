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

Six rule types, as codewatch had them: `metric-max`, `metric-min`, `metric-product-max`,
`forbid-import`, `layered-deps` (layers are path prefixes; an import may point only to its
own layer or a lower one), and `no-internal-only-barrels`. Severity defaults to `error`.

`snapshot` and `baseline` take a numeric id or a ref name, and a ref resolves to its newest
snapshot. `runChecks(store, { snapshotId, rules, baselineSnapshotId })` is the same engine on
ids.

**The baseline is a ratchet.** A violation whose key (rule id, node id, and destination id
for edge rules) also fires on the baseline is marked `isCarryover`. Only new errors set
`passed: false`, so existing debt never blocks a change and new debt always does.

## Diffing two snapshots

```ts
import { diffCheckResults, diffSnapshots } from "@titan-design/code-graph";

diffSnapshots(store, { fromSnapshotId: 1, toSnapshotId: 2 }).summary;
// { addedNodes: 36, removedNodes: 0, renamedNodes: 0, unchangedNodes: 108,
//   addedEdges: 77, removedEdges: 0, metricChanges: 20, … }

diffCheckResults(store, { fromSnapshotId: 1, toSnapshotId: 2, rules: tight }).newViolations;
// [ { nodeId: 'packages/code-graph/src/check/validate.ts', … } ]
```

`diffSnapshots` reports metric deltas only on nodes present in both snapshots. The
to-snapshot's `id_alias` rows carry a renamed file across, so a move is a rename rather than
a delete plus an add, and its edges do not churn. `diffCheckResults` buckets violations as
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
//   candidates: [ { id: 'packages/retrieval/src/fusion.ts#fuseByRRF', score: 0.864 },
//                 { id: 'packages/retrieval/src/fusion.ts#RankedList', score: 0.714 }, … ] }
```

The embedded text per symbol is its signature plus its docstring, never its body. Vectors live
in `blob_cache`, keyed by model and text hash rather than snapshot, so unchanged text is never
re-embedded. `tryEmbedSnapshot` reports a down backend instead of throwing. Results are
candidates with scores and a coverage figure, never verdicts.

**Keep one prefix per database.** `OllamaEmbedder` prepends its `prefix` to every text,
queries included, and its `model` does not record the prefix. Vectors made under two prefixes
would share a cache key. Python symbols carry no signature yet, so they are not searchable.

## The id scheme

Preserved exactly from codewatch, because this repo's `dag:check` consumes it:

- A **file** id is its path relative to the git toplevel, in posix form:
  `packages/registry/src/index.ts`. Ids root at the git toplevel even when you walk a
  subtree, so importers across subtrees share one id space.
- A **module** id is the file id minus its extension. Its parent is the directory above it.
- A **symbol** id hangs under its declaring file as `<fileId>#<name>`. `#` is legal in
  neither a posix path nor a JS identifier, so the first one is the split.
- An **external** id is `npm:<package>` (scope-aware) or the `node:` builtin verbatim.

## The three reuse tiers

Every run writes a fingerprint per file: a content hash, and a comment/whitespace-insensitive
hash of its parse structure. The next run diffs against the most recent snapshot carrying the
same `INDEX_VERSION`. That version is bumped whenever a metric can change for the same bytes,
not only when the node or edge shape changes. 0.12.0 marks `.tsx` files moving to the tsx
grammar (TP-166).

| Tier | Trigger | Work skipped |
| --- | --- | --- |
| reuse | content hash matches | parse and extract both; nodes, edges and source metrics carried forward verbatim |
| cosmetic | content changed, structural hash matches | the ts-morph extract; edges come from the basis, symbol line spans refreshed from the fresh parse |
| full | structural hash changed, or the file is new | nothing |

A file-membership delta (a file added or removed) forces the files whose imports it
re-resolves back to full extraction even when they are byte-identical. Degree metrics are
always recomputed over the whole assembled graph, so a heavily-reused run and an
`incremental: false` run produce the same snapshot — `indexer.test.ts` asserts that.

## Gotchas

**Workspace imports need the target package built.** An import of a workspace package by its
published name resolves to that package's *source* file, not to an `npm:` external, by
remapping the `dist/*.d.ts` entry ts-morph resolves back onto `src/`. That remap needs the
dist to exist, which is why `pnpm build` precedes both `pnpm test` and `dag:check` here.

**The symbol layer is hidden by default.** `listNodes` drops `symbol` nodes and `listEdges`
drops `references` edges unless you ask for them, so a caller reasoning about module
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

All of it follow-up work *on* this package rather than changes *to* it: git-history mining
(churn, ownership, change coupling, test linking), and every graph analysis over a finished
snapshot (communities, pagerank, partition quality, relevance, dead code, growth risk).
The rules engine, the snapshot diff, and symbol embeddings started here too and have since
been ported.

`buildIndexerMetrics` used to fold history into the same pass; here it computes only what a
file's own bytes and the assembled graph determine.

## Where it came from

codewatch's `@codewatch/graph`, split along the seam the audit identified: that package was
doing the job of both a store and a code graph. The store half became
[`store-sqlite`](/reference/store-sqlite).
