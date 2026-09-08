# @titan-design/code-graph

The dependency graph of a TypeScript or Python tree: files, modules, exported and internal
symbols, external packages, and the import / re-export / reference edges between them, with
index-time source metrics, in one SQLite file built from `@titan-design/store-sqlite` kit
tables and refreshed incrementally.

Tier 2 of the titan-platform DAG. Depends on `store-sqlite`, `ts-morph`, and the tree-sitter
WASM grammars. Extracted from codewatch's `@codewatch/graph` (TP-9), split along the seam the
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

In: the parser (tree-sitter WASM for TypeScript, TSX and Python), the walk, the ts-morph
extractor and its symbol layer, role classification, generated-file detection, id aliasing
across git renames, the three-tier incremental reuse, and the metrics computed at index time
(degree, utilization, loc, cyclomatic, cognitive, nesting, class count, lcom4, per-symbol
complexity). `lcom.ts` came along despite being an analysis: `source-metrics.ts` calls it
directly and lcom4 is a pure function of a file's bytes, so it belongs with the metrics that
carry forward under reuse.

Deferred, all of it still in codewatch, all of it a follow-up on this package rather than a
change to it:

- The rules engine (`check*.ts`) that turns a snapshot into pass/fail against a config.
- Git-history mining: churn, ownership, change coupling, symbol coupling, test coverage
  linking. `buildIndexerMetrics` used to fold these into the same pass; here it computes only
  what a file's own bytes and the assembled graph determine.
- Graph analyses over a finished snapshot: communities, pagerank, partition quality,
  relevance, conventions, coverage overlay, dead code, growth risk, patterns, prune,
  test-linker, diff, reuse-delta reporting, embeddings.

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
same `INDEX_VERSION` and sorts each file into one tier.

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
