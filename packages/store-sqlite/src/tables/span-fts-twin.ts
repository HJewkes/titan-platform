import type Database from "better-sqlite3";
import type { Db } from "../open.js";

export interface RawSpanHit {
  span_id: number;
  owner_ref: string;
  field: string;
  source_id: number;
  byte_offset: number;
  byte_length: number;
  rank: number;
}

/** Statements for the optional trigram twin, prepared only when the table was built with it. */
export interface Twin {
  table: string;
  insert: Database.Statement<[number, string]>;
  hasRow: Database.Statement<[number]>;
  search: Database.Statement<[string, number], RawSpanHit>;
  scopedCache: Map<string, Database.Statement<unknown[], RawSpanHit>>;
  deleteAll: Database.Statement<[]>;
  deleteOwner: Database.Statement<[string]>;
  deleteSource: Database.Statement<[number]>;
  count: Database.Statement<[], { n: number }>;
  countOrphans: Database.Statement<[], { n: number }>;
}

export function prepareTwin(db: Db, span: string, tri: string): Twin {
  return {
    table: tri,
    insert: db.prepare(`INSERT INTO ${tri} (rowid, text) VALUES (?, ?)`),
    hasRow: db.prepare(`SELECT 1 FROM ${tri} WHERE rowid = ?`),
    search: db.prepare<[string, number], RawSpanHit>(
      `SELECT s.span_id, s.owner_ref, s.field, s.source_id, s.byte_offset, s.byte_length, f.rank
       FROM ${tri} f JOIN ${span} s ON s.span_id = f.rowid
       WHERE ${tri} MATCH ? ORDER BY f.rank LIMIT ?`,
    ),
    scopedCache: new Map(),
    deleteAll: db.prepare(`INSERT INTO ${tri}(${tri}) VALUES ('delete-all')`),
    deleteOwner: db.prepare(`DELETE FROM ${tri} WHERE rowid IN (SELECT span_id FROM ${span} WHERE owner_ref = ?)`),
    deleteSource: db.prepare(`DELETE FROM ${tri} WHERE rowid IN (SELECT span_id FROM ${span} WHERE source_id = ?)`),
    count: db.prepare(`SELECT count(*) AS n FROM ${tri}`),
    countOrphans: db.prepare(`SELECT count(*) AS n FROM ${tri} WHERE rowid NOT IN (SELECT span_id FROM ${span})`),
  };
}
