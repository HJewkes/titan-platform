# Get started

## Install one package

Every package is published independently. Take the one you need; there is no meta-package
and nothing pulls the rest of the DAG in behind your back.

```sh
npm install @titan-design/store-sqlite
```

Requirements that apply to all of them:

- **Node 20 or newer**, and **ESM only**. There is no CommonJS build; `require()` will not
  work.
- **`zod` v4 is a peer dependency** of `registry`, `daemon`, `agent`, `hitl`, `memory`, and
  `workflow`. Install it yourself so one copy is shared: `npm install zod`.
- **`@huggingface/transformers` is an optional peer** of `embed` and `retrieval`. Without
  it, `embed`'s local backend and `retrieval`'s cross-encoder reranker are unavailable and
  every other path still works.
- Packages that store anything depend on `better-sqlite3`, which builds a native addon on
  install.

## A first example

This opens a database, installs two kit tables, indexes a piece of text for full-text
search, and links two entities with an edge. It is the shape most things here start from.

```ts
import {
  EdgeTable,
  SpanFtsTables,
  kitMigration,
  openDatabase,
  ref,
  runMigrations,
} from "@titan-design/store-sqlite";

const db = openDatabase(":memory:"); // WAL and foreign keys on; a path works the same
runMigrations(db, [kitMigration(1, { edge: true, spanFts: "search" })]);

const spans = new SpanFtsTables(db, { name: "search" });
const text = "the daemon returns 503 until the pid file exists";
spans.index(
  { ownerRef: ref("session", "abc"), field: "prompt", sourceId: 1, byteOffset: 0, byteLength: text.length },
  text,
);

console.log(spans.search("daemon OR 503", 5).map((hit) => hit.ownerRef));
// [ 'session:abc' ]

const edges = new EdgeTable(db);
edges.assert({ sourceRef: ref("session", "abc"), relation: "touched", targetRef: ref("file", "repo/a.ts") });
console.log(edges.from("session:abc").map((edge) => edge.targetRef));
// [ 'file:repo/a.ts' ]
```

Two things in there are load-bearing everywhere else on this site.

**Refs.** `ref("session", "abc")` is just the string `session:abc`. Every domain mints refs
for its own entities and the edge table links them, which is how a session graph and a code
graph end up in one queryable space without either knowing about the other.

**The FTS index stores no text.** `spans.index` records a byte range and feeds a
contentless FTS5 table. Searching gives you back a locator, and
[`locator`](/reference/locator) reads the original bytes out of the source file. Nothing
duplicates the corpus.

## Try the whole DAG at once

The session miner is a working product built from ten of these packages. It is private, so
run it from a checkout rather than npm:

```sh
git clone https://github.com/HJewkes/titan-platform
cd titan-platform
pnpm install && pnpm build
node products/session-miner/dist/bin.js refresh   # index your Claude Code transcripts
node products/session-miner/dist/bin.js search "daemon 503 at startup"
```

`refresh` reads `~/.claude/projects` and writes to `~/.local/state/titan-session-miner`.
Both are overridable with `--corpus` and `--state`. Every command takes `--json` and
returns the same envelope the HTTP and MCP surfaces return.

[The case study](/guides/session-miner) walks through which package does what in that
pipeline.

## Where each package fits

Pick by problem:

| Problem | Package |
| --- | --- |
| I need SQLite tables for a graph, a search index, or an ingest watermark | [`store-sqlite`](/reference/store-sqlite) |
| I need to point at a byte range in a file instead of copying its text | [`locator`](/reference/locator) |
| I need to group thousands of error blobs into a handful of templates | [`cluster`](/reference/cluster) |
| I need embeddings, but not a mandatory model download | [`embed`](/reference/embed) |
| I need search that keeps working when a retriever is down | [`retrieval`](/reference/retrieval) |
| I need to run a headless Claude Code session with a hard budget | [`agent`](/reference/agent) |
| I need one command definition to serve a CLI, MCP, and HTTP | [`registry`](/reference/registry) |
| I need to host that on a loopback port with health, SSE, and a pid file | [`daemon`](/reference/daemon) |
| I need to pause work on a human and resume it from another process | [`hitl`](/reference/hitl) |
| I need to read Claude Code transcripts | [`session-read`](/reference/session-read) |
| I need those transcripts as a queryable, incrementally maintained graph | [`session-graph`](/reference/session-graph) |
| I need the import graph of a TypeScript or Python tree | [`code-graph`](/reference/code-graph) |
| I need a rule playbook whose confidence decays with evidence | [`memory`](/reference/memory) |
| I need a long-running process that survives a restart mid-flight | [`workflow`](/reference/workflow) |
