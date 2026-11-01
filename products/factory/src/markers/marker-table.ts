import type { Migration } from "@titan-design/store-sqlite";

/** A blob at or under this many bytes sits inline in the database; a larger one goes to a file and the row keeps its path. */
const INLINE_LIMIT_BYTES = 256 * 1024;

const MARKER_DDL = `
  CREATE TABLE factory_marker (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    item              TEXT NOT NULL,
    fact              TEXT NOT NULL,
    pin_class         TEXT NOT NULL CHECK (pin_class IN ('tree', 'diff', 'observed', 'item', 'landed')),
    pin               TEXT NOT NULL,
    pin_seq           INTEGER,
    expires_at        TEXT,
    step              TEXT NOT NULL,
    call_site         TEXT NOT NULL,
    version           TEXT NOT NULL,
    input_digests     TEXT NOT NULL DEFAULT '{}',
    reads             TEXT NOT NULL DEFAULT '[]',
    output_digest     TEXT,
    projection_digest TEXT,
    run_id            TEXT,
    memo_key          TEXT,
    reverted          INTEGER NOT NULL DEFAULT 0 CHECK (reverted IN (0, 1)),
    written_at        TEXT NOT NULL,
    CHECK (reverted = 0 OR (fact = 'landed' AND pin_class = 'landed')),
    CHECK (expires_at IS NULL OR pin_class = 'observed')
  );
  CREATE INDEX factory_marker_identity ON factory_marker (item, fact, pin_class, pin, id);
  CREATE INDEX factory_marker_item ON factory_marker (item, id);
  CREATE INDEX factory_marker_step_version ON factory_marker (step, version);
  CREATE INDEX factory_marker_run ON factory_marker (run_id, memo_key) WHERE run_id IS NOT NULL;
  CREATE TRIGGER factory_marker_no_update BEFORE UPDATE ON factory_marker BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER factory_marker_no_delete BEFORE DELETE ON factory_marker BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER factory_marker_no_replace BEFORE INSERT ON factory_marker
    FOR EACH ROW WHEN EXISTS (SELECT 1 FROM factory_marker WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER factory_marker_reverted_terminal BEFORE INSERT ON factory_marker
    FOR EACH ROW WHEN EXISTS (SELECT 1 FROM factory_marker WHERE item = NEW.item AND reverted = 1)
  BEGIN SELECT RAISE(ABORT, 'reverted item is terminal'); END;

  CREATE TABLE factory_marker_blob (
    digest     TEXT PRIMARY KEY,
    bytes      INTEGER NOT NULL,
    inline     BLOB,
    path       TEXT,
    created_at TEXT NOT NULL,
    CHECK ((inline IS NULL) <> (path IS NULL)),
    CHECK (path IS NULL OR bytes > ${INLINE_LIMIT_BYTES})
  );

  CREATE TABLE factory_marker_root (
    marker_id INTEGER NOT NULL REFERENCES factory_marker (id),
    kind      TEXT NOT NULL CHECK (kind IN ('eval')),
    reason    TEXT NOT NULL,
    added_at  TEXT NOT NULL,
    PRIMARY KEY (marker_id, kind)
  );`;

/**
 * The v9.1 marker table (TP-3105 S1); 49 follows the Shepherd tenant's gate evidence at 48. Identity is
 * (item, fact, pin_class, pin) and the highest id at an identity is current, so a rewrite inserts and superseded rows stay.
 * output_digest carries no foreign key: GC collects blobs while their marker rows stay, and a missing blob reads as missing.
 * REPLACE deletes the clashing row without firing the delete trigger when recursive_triggers is off, so a clashing id aborts first.
 */
export function markerTableMigration(version = 49): Migration {
  return { version, name: "factory:marker_table", up: (db) => db.exec(MARKER_DDL) };
}
