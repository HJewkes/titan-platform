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

Verified against the contract at 0.1.2, on an index of titan-platform itself.

```ts
import { loadCheckRules, openCodeGraph } from "@titan-design/code-graph";
import { registerCodeReadCommands } from "@titan-design/code-read";
import { createRegistry, invokeCommand } from "@titan-design/registry";

const registry = createRegistry();
const rules = await loadCheckRules(".codewatch/check.json");
registerCodeReadCommands(registry, {
  openStore: () => openCodeGraph(".codewatch/graph.db"),
  rules: () => rules,
  repoRoot: process.cwd(),
});

const ctx = { warnings: [], format: "json" as const };
const { envelope } = await invokeCommand(registry.get("snapshot.list")!, { limit: 5 }, ctx);
// { ok: true, data: { snapshots: [{ id: 1, ref: "main", commit: "4da1b09…", takenAt: "…", indexVersion: "0.14.0" }] } }

const found = await invokeCommand(registry.get("node.resolve")!, { query: "packages/code-read/src/query/tree.ts:120" }, ctx);
// candidates: [{ node: { id: "packages/code-read/src/query/tree.ts#attachSymbols", kind: "symbol", span: { startLine: 109, endLine: 123 }, … }, score: 100, match: "span" }]

const tree = await invokeCommand(registry.get("hierarchy.get")!, { depth: 1, metrics: ["loc", "churn_30d_commits"] }, ctx);
// nodes[0]: { id: "", kind: "repo", values: { loc: 57797, churn_30d_commits: null }, missing: { churn_30d_commits: "no-rollup" }, … }

const worst = await invokeCommand(registry.get("findings.list")!, { scope: "packages/", limit: 1, facets: true }, ctx);
// rows[0]: { id: "demo-max-loc|packages/agent/src/durable-dispatcher.ts", severity: "error", excess: 1.332,
//   message: "loc=333 > 250", provenance: { kind: "derived", source: "check/demo-max-loc" }, … }
// total: 43, facets.rule: { "demo-max-cognitive": 14, "demo-max-loc": 12, "demo-no-node-in-code-read": 17 }, …

const one = await invokeCommand(registry.get("finding.get")!, { id: "demo-no-node-in-code-read|packages/code-read/src/browser-safe.test.ts|node:fs" }, ctx);
// finding.range: { startLine: 1, endLine: 1 }; excerpt: { startLine: 1, endLine: 6, origin: "worktree", highlights: [{ startLine: 1, endLine: 1 }], … }

const near = await invokeCommand(registry.get("node.neighbors")!, { id: "packages/code-read/src/query/contract.ts", limit: 2 }, ctx);
// outbound: [{ node: { id: "npm:zod", kind: "external", … }, kind: "imports", weight: 24, … }, { node: { id: "…/query/schemas.ts", … }, weight: 5, … }]
```

The `demo-*` rules in the findings example are stricter than titan-platform's own
`.codewatch/check.json`, which the repo passes with zero findings.

Without a daemon, `createQueryResolver(source)("api.describe", {})` returns the same
envelope from any `ReadSource`.

## What it deliberately does not do

It writes nothing: indexing, embedding, and the findings store belong to `code-graph`. It
does not read code-graph's stored findings and verdicts yet: every finding it serves is a
check-rule violation computed when a snapshot loads. It carries no product policy. The check rules, the MCP tool prefix, and which commands a surface
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
- **A derived finding disappears when its rule or baseline changes.** Findings are computed
  on read from the rules the product passes. Raise a threshold or remove a rule and its
  findings vanish from every snapshot, old ones included. A row's `status` depends on the
  `baseline` argument. Do not store a finding id as durable until the findings store lands.
- A finding id is code-graph's `violationKey` (`rule|node` or `rule|node|destination`).
  Treat it as opaque; it is not rename-aware until TP-187.
- `rules` must return the same array while the rules are unchanged. The live source drops
  every cached model when it sees a different array, so returning a fresh copy on each call
  reloads the snapshot every time.
- An import finding's flagged line is found by searching the file for the quoted specifier,
  because edges carry no line numbers. A metric finding covers its whole file and has no
  `range`. Excerpts come from the working tree under `repoRoot` only when the file's hash
  matches the snapshot; otherwise `excerptMissing: "changed-since-snapshot"`.
- `node.neighbors` takes a stored node. A directory id is DATAERR; use `hierarchy.get` for
  directories until `deps.matrix` lands.
- A metric name missing from code-graph's catalogue is still served, with `rollup: "none"`,
  `direction: "neutral"`, and a provenance source ending in `/uncatalogued`.

## Where it came from

New in September 2026 (TP-184), step 2 of the TP-132 read API design. Findings and
neighbours arrived in step 4 (TP-186). It replaces
codewatch's CLI-side `read-api` module, whose contract constant it follows, with a package
that the report app, MCP, and workflows share.
