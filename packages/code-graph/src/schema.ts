import { kitMigration, type Migration } from "@titan-design/store-sqlite";

/**
 * Kit table names. The code graph is snapshot-scoped end to end: a whole repo is
 * re-indexed together, so `snapshotTableDdl` + `entitySnapTableDdl` are the right
 * time model and the interval `edgeTableDdl` is not — one unchanged import would
 * otherwise write a row per file per snapshot. The edge table below is therefore
 * the snapshot-scoped counterpart, owned here.
 */
export const KIT = { snapshot: "snapshot", entitySnap: "node", cacheBlob: "blob_cache" } as const;

/**
 * Two columns the kit's `entity_snap` shape does not carry but every consumer of
 * a code graph reads directly, plus the snapshot provenance the reuse basis
 * selects on. Kept as real columns rather than folded into `attrs` so the
 * vocabularies stay queryable and stay codewatch-compatible.
 */
const KIT_EXTENSIONS = `
  ALTER TABLE node ADD COLUMN language TEXT;
  ALTER TABLE node ADD COLUMN role TEXT;
  ALTER TABLE snapshot ADD COLUMN commit_hash TEXT;
  ALTER TABLE snapshot ADD COLUMN index_version TEXT NOT NULL DEFAULT '';
`;

/**
 * Domain tables. `edge` is the snapshot-scoped edge shape (the kit's own edge
 * table is bi-temporal); `metric` holds index-time measurements keyed by node;
 * `id_alias` carries a node id across a rename so two snapshots line up; and
 * `file_fingerprint` is the reuse basis the incremental indexer diffs against.
 */
export const DOMAIN_DDL = `
  CREATE TABLE IF NOT EXISTS edge (
    snapshot_id INTEGER NOT NULL,
    src_id      TEXT NOT NULL,
    dst_id      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    attrs       TEXT,
    PRIMARY KEY (snapshot_id, src_id, dst_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(snapshot_id, dst_id);
  CREATE INDEX IF NOT EXISTS idx_edge_kind ON edge(snapshot_id, kind);

  CREATE TABLE IF NOT EXISTS metric (
    snapshot_id INTEGER NOT NULL,
    node_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    value       REAL,
    unit        TEXT,
    PRIMARY KEY (snapshot_id, node_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_metric_name ON metric(snapshot_id, name);

  CREATE TABLE IF NOT EXISTS id_alias (
    snapshot_id INTEGER NOT NULL,
    old_id      TEXT NOT NULL,
    new_id      TEXT NOT NULL,
    reason      TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, old_id, new_id)
  );

  CREATE TABLE IF NOT EXISTS file_fingerprint (
    snapshot_id     INTEGER NOT NULL,
    file_id         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    structural_hash TEXT,
    PRIMARY KEY (snapshot_id, file_id)
  );
`;

export const MIGRATIONS: Migration[] = [
  kitMigration(1, { snapshot: KIT.snapshot, entitySnap: KIT.entitySnap, cacheBlob: KIT.cacheBlob }),
  { version: 2, name: "code graph columns", up: (db) => db.exec(KIT_EXTENSIONS) },
  { version: 3, name: "code graph tables", up: (db) => db.exec(DOMAIN_DDL) },
];
