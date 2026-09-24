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
- **`zod` v4 is a peer dependency** of `registry`, `daemon`, `agent`, `hitl`, `memory`,
  `workflow`, `chat-protocol`, `messaging`, `code-read`, `session-analytics`, and the three
  `style-*` packages. Install it yourself so one copy is shared: `npm install zod`.
- **`web-tree-sitter` is a peer** of `code-parser` and `style-analyzer`.
- **React 18 or 19 is a peer** of `react-app`, with Vite optional for its `./vite` entry.
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
| I need to run a headless Claude Code or Codex session with a hard budget | [`agent`](/reference/agent) |
| I need one command definition to serve a CLI, MCP, and HTTP | [`registry`](/reference/registry) |
| I need to host that on a loopback port with health, SSE, and a pid file | [`daemon`](/reference/daemon) |
| I need to pause work on a human and resume it from another process | [`hitl`](/reference/hitl) |
| I need to read Claude Code or Codex transcripts | [`session-read`](/reference/session-read) |
| I need those transcripts as a queryable, incrementally maintained graph | [`session-graph`](/reference/session-graph) |
| I need the import and call graph of a TypeScript or Python tree, with metrics and checks | [`code-graph`](/reference/code-graph) |
| I need a rule playbook whose confidence decays with evidence | [`memory`](/reference/memory) |
| I need a long-running process that survives a restart mid-flight | [`workflow`](/reference/workflow) |
| I need to run many agent steps under a concurrency and budget cap | [`workflow`](/reference/workflow) (`mapItems`) |
| I need a durable record of which process owns a running agent | [`agent-lifecycle`](/reference/agent-lifecycle) |
| I need identity and usage types that do not care which harness ran | [`agent-protocol`](/reference/agent-protocol) |
| I need a cost report, roles, or episodes over mined sessions | [`session-analytics`](/reference/session-analytics) |
| I need to parse TypeScript or Python with tree-sitter | [`code-parser`](/reference/code-parser) |
| I need a read API over a code graph that a browser can call | [`code-read`](/reference/code-read) |
| I need to learn a repo's code style and enforce it | [`style-analyzer`](/reference/style-analyzer), [`style-profile`](/reference/style-profile), [`style-checker`](/reference/style-checker) |
| I need to check that a model's cited lines really say what it claims | [`evidence`](/reference/evidence) |
| I need the envelope, routes, and SSE vocabulary a daemon and its clients share | [`rpc-protocol`](/reference/rpc-protocol) |
| I need a typed daemon client in a browser, live or from a snapshot file | [`rpc-client`](/reference/rpc-client) |
| I need React hooks and a Vite preset for a daemon-backed app | [`react-app`](/reference/react-app) |
| I need one chat message shape across every agent-chat surface | [`chat-protocol`](/reference/chat-protocol) |
| I need to send and receive over iMessage or Telegram | [`messaging`](/reference/messaging) |
| I need to talk to a Matrix homeserver without an SDK | [`matrix-bus`](/reference/matrix-bus) |
| I need human approvals and questions to show up in a Matrix room | [`queue-mirror`](/reference/queue-mirror) |

The [package families](/guides/package-families) guide groups these by the job they share.
