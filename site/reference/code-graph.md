# code-graph

**Tier 2 · domain.** Depends on [`store-sqlite`](/reference/store-sqlite), `ts-morph`, and
the tree-sitter WASM grammars.

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

This repo's own `pnpm dag:check` runs on it, through codewatch's CLI.

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
same `INDEX_VERSION`.

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

**Python support is narrower than TypeScript.** It is new here rather than ported: no type
checker, so imports resolve by dotted path against the tree, and symbols come from the same
tree-sitter declaration walk that feeds complexity.

## What was deliberately left in codewatch

All of it follow-up work *on* this package rather than changes *to* it: the rules engine that
turns a snapshot into pass/fail, git-history mining (churn, ownership, change coupling, test
linking), and every graph analysis over a finished snapshot (communities, pagerank, partition
quality, relevance, dead code, growth risk, diff, embeddings).

`buildIndexerMetrics` used to fold history into the same pass; here it computes only what a
file's own bytes and the assembled graph determine.

## Where it came from

codewatch's `@codewatch/graph`, split along the seam the audit identified: that package was
doing the job of both a store and a code graph. The store half became
[`store-sqlite`](/reference/store-sqlite).
