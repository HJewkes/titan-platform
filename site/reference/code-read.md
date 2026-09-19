# code-read

**Tier 2 · domain.** Depends on [`code-graph`](/reference/code-graph),
[`registry`](/reference/registry), and [`rpc-protocol`](/reference/rpc-protocol); `zod` is
a peer.

```sh
npm install @titan-design/code-read zod
```

## The problem it solves

A code-graph snapshot lives in SQLite, and every consumer read it its own way. The report
UI, agents over MCP, and workflows each needed their own queries, their own result shapes,
and no promise that those shapes would hold still. A static export of the report could
only record answers or reimplement the queries in the browser.

The primitive is **one versioned contract answered by pure functions over a per-snapshot
`ReadModel`**. The daemon's registry commands and a browser reading a static dataset call
the same functions through the same `ReadSource` seam. Their answers are identical by
construction.

## When to reach for it

Reach for it in a product that serves code-graph data to a UI, an agent, or a workflow.
Register the commands on the product's registry and host them with
[`daemon`](/reference/daemon). A browser app imports `@titan-design/code-read/query` for
the contract types and the resolver. Code that writes snapshots (indexing, embedding,
checks) still uses [`code-graph`](/reference/code-graph) directly.

## Example

Verified against the contract at 0.1.1.

```ts
import { openCodeGraph } from "@titan-design/code-graph";
import { registerCodeReadCommands } from "@titan-design/code-read";
import { createRegistry, invokeCommand } from "@titan-design/registry";

const registry = createRegistry();
registerCodeReadCommands(registry, { openStore: () => openCodeGraph(".codewatch/graph.db") });

const ctx = { warnings: [], format: "json" as const };
const { envelope } = await invokeCommand(registry.get("snapshot.list")!, { limit: 5 }, ctx);
// { ok: true, data: { snapshots: [{ id: 1, ref: "main", commit: "4da1b09…", takenAt: "…", indexVersion: "0.14.0" }] } }

const found = await invokeCommand(registry.get("node.resolve")!, { query: "packages/code-read/src/query/tree.ts:120" }, ctx);
// candidates: [{ node: { id: "packages/code-read/src/query/tree.ts#attachSymbols", kind: "symbol", span: { startLine: 109, endLine: 123 }, … }, score: 100, match: "span" }]

const tree = await invokeCommand(registry.get("hierarchy.get")!, { depth: 1, metrics: ["loc", "churn_30d_commits"] }, ctx);
// nodes[0]: { id: "", kind: "repo", values: { loc: 57797, churn_30d_commits: null }, missing: { churn_30d_commits: "no-rollup" }, … }
```

Without a daemon, `createQueryResolver(source)("api.describe", {})` returns the same
envelope from any `ReadSource`.

## What it deliberately does not do

It writes nothing: indexing, embedding, and the findings store belong to `code-graph`. It
carries no product policy. The check rules, the MCP tool prefix, and which commands a surface
exposes all come from the product. It does not define the static file container. That is
`rpc-client`'s, and a code-read dataset rides inside it as an opaque payload. It does not
open a daemon; `daemon` does.

## Gotchas

- `CODE_READ_API_VERSION` is the contract's version, not the package's npm version. Check
  `major(api)` at runtime, and while it is `0` treat a minor bump as breaking.
- `api.describe` loads the newest snapshot's whole model to build the metric catalogue, so
  the first call after a new index costs a full snapshot read. Later calls hit the LRU.
- `openStore` runs once, on first use, and the live source keeps the store for its
  lifetime. Close the store yourself when the product shuts down.
- The daemon lists every registered command as an MCP tool. To expose only some, register
  `defineCodeReadCommands(source)` selectively on a second registry.
- A directory's id ends in `/` and the repo's id is `""`. Pass those, not bare paths, as
  `root` or `id`; `node.resolve` turns a bare path into the id.
- A directory gets no value for a metric whose catalogue rollup is `none`, which covers
  commit and author counts, bus factor, recency, fan-in, and linked tests. The row says
  `missing: "no-rollup"`. Directory-level history is TP-233.
- `node.get`'s `siblingRank` and `percentile` ignore direction: rank 1 is the largest value
  and percentile is the share of same-kind nodes at or below it. For `loc`
  (`direction: "higher-worse"`), rank 1 is the file with the most lines, the worst offender,
  not the best. For `bus_factor_30d` (`direction: "lower-worse"`), rank 1 is the safest file.
  Read `direction` on the same metric before labelling anything "top" or "best".
- Baseline deltas match nodes by id, so a moved file reads as removed plus added until alias
  following lands (TP-187).
- A metric name missing from code-graph's catalogue is still served, with `rollup: "none"`,
  `direction: "neutral"`, and a provenance source ending in `/uncatalogued`.

## Where it came from

New in September 2026 (TP-184), step 2 of the TP-132 read API design. It replaces
codewatch's CLI-side `read-api` module, whose contract constant it follows, with a package
that the report app, MCP, and workflows share.
