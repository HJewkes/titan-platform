# @titan-design/store-sqlite

A kit of composable SQLite table factories, not a shared database. Brain, codewatch, and
the session miner each keep their own physical database and their own domain tables; what
they share is the boilerplate they had each hand-rolled and one grammar for linking across
domains.

Tier 0 of the titan-platform DAG. Depends on `better-sqlite3` (TP-4). Design in the
initiative's `sources/research-store-synthesis.md`.

## Open and migrate

```ts
import { openDatabase, runMigrations, kitMigration } from "@titan-design/store-sqlite";

const db = openDatabase("~/.local/state/thing/index.sqlite3"); // WAL + foreign keys on
runMigrations(db, [
  kitMigration(1, { edge: true, watermark: true, spanFts: "notes", cacheBlob: true }),
  { version: 2, up: (db) => db.exec("CREATE TABLE my_domain_table (...)") },
]);
```

Migrations are `{ version, up(db) }`, applied in order, each in its own transaction, and
recorded in a `_migration` table. `hasTable` and `hasColumn` make `ALTER` migrations
idempotent.

### Refusing a database from the future

Migrations only move forward, so a database stamped past the highest migration a runtime
knows was written by a newer version of that runtime: the columns this process is about to
query may already be gone. Pass the version you own and `openDatabase` refuses it up front
instead of letting a query die on a dropped column much later.

```ts
const db = openDatabase(dbPath, { schemaVersion: 2 }); // throws SchemaTooNewError at 3
```

`SchemaTooNewError` carries `storedVersion` and `knownVersion`, and its `name` is set, so a
caller can tell "upgrade the package" apart from a migration that genuinely failed.
`assertSchemaVersion(db, knownVersion)` is the same check on an open connection, for a
read-only open that cannot run migrations at all.

The check is opt-in because only a caller that owns the whole schema can name that version.
A store layering its own migrations onto a shared database sees one band of versions rather
than the top of it — `products/session-miner` numbers its own from 1000 precisely so it can
sit above `@titan-design/session-graph`'s.

### Refusing a renamed migration

Migrations are `{ version, name?, up(db) }`, and the name is recorded beside the version.
When an already-applied version's recorded name differs from the declared one,
`runMigrations` throws `MigrationIdentityError` (carrying `version`, `recordedName`, and
`declaredName`) instead of skipping it. That catches two migration lists that collided on a
version number, so neither believes in a schema it never applied. A migration with no
declared name, or a row recorded before names were kept, is never compared.

## The primitives

Every factory takes an optional `name` so a store can host several instances or keep a
legacy table name. All DDL is `IF NOT EXISTS`.

| Factory | Table | Helper class | Use when |
|---|---|---|---|
| `edgeTableDdl` | interval bi-temporal edges: `source_ref`, `relation`, `target_ref`, `t_valid/t_invalid`, `t_created/t_expired`, `fact_id`, `confidence`, `attrs`; partial indexes on live rows | `EdgeTable`: `assert`, `expire`, `supersede`, `current`, `from`, `to` | the cross-domain graph; relation names are free strings, corrections expire rather than delete |
| `entityTableDdl` | interval entity keyed by ref, with `kind`, `name`, `parent_ref`, `attrs` | `EntityTable`: `upsert`, `get`, `expire`, `listByKind` | facts that change one at a time (memory, sessions) |
| `snapshotTableDdl` + `entitySnapTableDdl` | snapshot registry and snapshot-keyed entities (`PRIMARY KEY (snapshot_id, id)`) | none yet | a whole population re-indexed together (a code graph) |
| `cacheBlobTableDdl` | `(namespace, model, content_hash)` to a blob plus JSON meta | `CacheBlobTable`: `get`, `put`, `getOrCompute`, `count` | embeddings and summaries: pure functions of text, stored once |
| `spanFtsTablesDdl` | `<name>_span` locators plus a contentless FTS5 `<name>_fts` | `SpanFtsTables`: `index`, `search`, `purgeOwner`, `orphanRatio`, `clearIndex` | full-text search where the text lives elsewhere |
| `watermarkTableDdl` | per-source offset, prefix hash, size/mtime/content hash, status | `WatermarkTable`: `ensure`, `advance`, `rewind`, `markStatus`, `list` | incremental ingest of append-mostly sources |

The two time models are deliberately both here. Snapshot scoping is right when everything
is re-indexed at once; forcing it on live single-event ingestion breaks it. Interval rows
are right when facts change independently; forcing them on a snapshot graph writes an
unchanged row per node per snapshot. One physical table cannot serve both.

## Contentless FTS rule

`SpanFtsTables.search` always joins the FTS table through the span table. A contentless
FTS5 table cannot delete a row without its original text, so purges strand FTS rows; the
join hides them, `orphanRatio` tells you when to `clearIndex` and re-stream.

## Refs

`ref("session", "abc")` gives `session:abc`; `parseRef` splits on the first colon so ids
may contain colons and hashes (`codewatch:repo#src/a.ts::Foo`). `refKind("task")` returns
a typed minter. Each domain mints refs for its own entities; the edge table links them.
