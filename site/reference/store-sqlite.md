# store-sqlite

**Tier 0 · primitives.** No titan dependencies. Requires `better-sqlite3`.

```sh
npm install @titan-design/store-sqlite
```

## The problem it solves

Three projects each hand-rolled the same SQLite boilerplate: open with the right pragmas,
run ordered migrations, keep a table of edges between things, keep a full-text index, keep a
watermark for incremental ingest. The tables were subtly different every time and none of
them could link to another.

This is a **kit of composable table factories, not a shared database**. Every product keeps
its own physical file and its own domain tables. What they share is the boilerplate and one
grammar for linking across domains.

## When to reach for it

You are storing anything in SQLite and you want a graph of edges, a search index that does
not duplicate your text, a cache keyed by content hash, or a resumable ingest position.
Take the factories you want and ignore the rest; the DDL is `IF NOT EXISTS` and every
factory takes an optional table name.

## Example

Verified against 0.1.0.

```ts
import {
  EdgeTable,
  SpanFtsTables,
  kitMigration,
  openDatabase,
  ref,
  runMigrations,
} from "@titan-design/store-sqlite";

const db = openDatabase(":memory:"); // WAL and foreign keys on
runMigrations(db, [
  kitMigration(1, { edge: true, spanFts: "search", watermark: true }),
  { version: 2, up: (db) => db.exec("CREATE TABLE IF NOT EXISTS note (id TEXT PRIMARY KEY)") },
]);

const edges = new EdgeTable(db);
edges.assert({ sourceRef: ref("session", "abc"), relation: "touched", targetRef: ref("file", "repo/a.ts") });
edges.from("session:abc");   // [{ targetRef: 'file:repo/a.ts', ... }]

const spans = new SpanFtsTables(db, { name: "search" });
const text = "the daemon returns 503 until the pid file exists";
spans.index(
  { ownerRef: "session:abc", field: "prompt", sourceId: 1, byteOffset: 0, byteLength: text.length },
  text,
);
spans.search("daemon OR 503", 5);   // [{ ownerRef: 'session:abc', byteOffset: 0, ... }]
```

Migrations are `{ version, up(db) }`, applied in order, each in its own transaction, and
recorded in a `_migration` table. `hasTable` and `hasColumn` make `ALTER` migrations
idempotent.

## The factories

| Factory | Helper class | Use when |
| --- | --- | --- |
| `edgeTableDdl` | `EdgeTable`: `assert`, `expire`, `supersede`, `current`, `from`, `to` | the cross-domain graph. Interval bi-temporal rows; relation names are free strings; corrections expire rather than delete |
| `entityTableDdl` | `EntityTable`: `upsert`, `get`, `expire`, `listByKind` | facts that change one at a time (memory, sessions) |
| `snapshotTableDdl` + `entitySnapTableDdl` | none yet | a whole population re-indexed together (a code graph) |
| `cacheBlobTableDdl` | `CacheBlobTable`: `get`, `put`, `getOrCompute`, `count` | embeddings and summaries: pure functions of text, stored once, keyed by `(namespace, model, content_hash)` |
| `spanFtsTablesDdl` | `SpanFtsTables`: `index`, `search`, `purgeOwner`, `orphanRatio`, `clearIndex` | full-text search where the text lives elsewhere |
| `watermarkTableDdl` | `WatermarkTable`: `ensure`, `advance`, `rewind`, `markStatus`, `list` | incremental ingest of append-mostly sources |

## Refs

`ref("session", "abc")` produces the string `session:abc`. `parseRef` splits on the *first*
colon, so ids may contain colons and hashes: `codewatch:repo#src/a.ts::Foo` parses cleanly.
`refKind("task")` returns a typed minter.

Each domain mints refs for its own entities and the edge table links them. That is the whole
mechanism by which a session graph and a code graph become one queryable space without
either knowing about the other.

## Gotchas

**Two time models, and you must pick.** Interval rows (`entityTableDdl`, `edgeTableDdl`) are
right when facts change independently. Snapshot rows (`entitySnapTableDdl`) are right when a
whole population is re-indexed at once. Forcing snapshots on live single-event ingestion
breaks it; forcing interval rows on a snapshot graph writes an unchanged row per node per
run. One physical table cannot serve both, so both ship. See
[Architecture](/guides/architecture#two-time-models-on-purpose).

**`SpanFtsTables.search` takes `(query, limit)`**, positionally, and the query is passed to
FTS5 — `"daemon OR 503"`, not `"daemon 503"`, unless you want the implicit AND.

**Contentless FTS strands rows.** `search` always joins the FTS table through the span
table, because a contentless FTS5 table cannot delete a row without its original text. Purges
leave orphan FTS rows; the join hides them, `orphanRatio()` tells you when to `clearIndex()`
and re-stream.

## Where it came from

codewatch's `@codewatch/graph`, which was doing the job of both a store and a code graph.
The split produced this package and [`code-graph`](/reference/code-graph). FTS5 and the
bi-temporal edge model were added here.
