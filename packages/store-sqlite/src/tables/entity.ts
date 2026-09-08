import { SQL_NOW, nowIso, quoteIdent, type Db } from "../open.js";

/**
 * Two entity shapes, because the projects that converged on "kind + name +
 * parent + JSON attrs" genuinely diverge on time. Snapshot-scoped rows are
 * right when a whole population is re-indexed together (a code graph);
 * interval rows are right when facts change one at a time (memory, sessions).
 */
export interface TableName {
  name?: string;
}

/** Snapshot-scoped entity: every row belongs to one snapshot. */
export function entitySnapTableDdl({ name = "entity_snap" }: TableName = {}): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      snapshot_id INTEGER NOT NULL,
      id          TEXT NOT NULL,
      kind        TEXT NOT NULL,
      name        TEXT,
      parent_id   TEXT,
      attrs       TEXT,
      PRIMARY KEY (snapshot_id, id)
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_kind`)} ON ${t}(snapshot_id, kind);
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_parent`)} ON ${t}(snapshot_id, parent_id);
  `;
}

/** The snapshot registry the snapshot-scoped tables key on. */
export function snapshotTableDdl({ name = "snapshot" }: TableName = {}): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      id       INTEGER PRIMARY KEY,
      ref      TEXT NOT NULL,
      taken_at TEXT NOT NULL DEFAULT (${SQL_NOW}),
      attrs    TEXT
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_ref`)} ON ${t}(ref, taken_at);
  `;
}

/** Interval bi-temporal entity keyed by its cross-domain ref. */
export function entityTableDdl({ name = "entity" }: TableName = {}): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      ref        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      name       TEXT,
      parent_ref TEXT,
      attrs      TEXT,
      t_valid    TEXT NOT NULL,
      t_invalid  TEXT,
      t_created  TEXT NOT NULL DEFAULT (${SQL_NOW}),
      t_expired  TEXT
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_kind`)} ON ${t}(kind) WHERE t_expired IS NULL;
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_parent`)} ON ${t}(parent_ref) WHERE t_expired IS NULL;
  `;
}

export interface EntityInput {
  ref: string;
  kind: string;
  name?: string | null;
  parentRef?: string | null;
  attrs?: Record<string, unknown> | null;
  tValid?: string;
}

export interface EntityRow {
  ref: string;
  kind: string;
  name: string | null;
  parentRef: string | null;
  attrs: Record<string, unknown> | null;
  tValid: string;
  tInvalid: string | null;
  tCreated: string;
  tExpired: string | null;
}

interface RawEntityRow {
  ref: string;
  kind: string;
  name: string | null;
  parent_ref: string | null;
  attrs: string | null;
  t_valid: string;
  t_invalid: string | null;
  t_created: string;
  t_expired: string | null;
}

function toEntityRow(raw: RawEntityRow): EntityRow {
  return {
    ref: raw.ref,
    kind: raw.kind,
    name: raw.name,
    parentRef: raw.parent_ref,
    attrs: raw.attrs === null ? null : (JSON.parse(raw.attrs) as Record<string, unknown>),
    tValid: raw.t_valid,
    tInvalid: raw.t_invalid,
    tCreated: raw.t_created,
    tExpired: raw.t_expired,
  };
}

/** Prepared helpers over one interval entity table. */
export class EntityTable {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly expireStmt;
  private readonly byKindStmt;

  constructor(db: Db, { name = "entity" }: TableName = {}) {
    const t = quoteIdent(name);
    this.upsertStmt = db.prepare(
      `INSERT INTO ${t} (ref, kind, name, parent_ref, attrs, t_valid)
       VALUES (@ref, @kind, @name, @parentRef, @attrs, @tValid)
       ON CONFLICT (ref) DO UPDATE SET
         kind = excluded.kind, name = excluded.name, parent_ref = excluded.parent_ref,
         attrs = excluded.attrs, t_expired = NULL, t_invalid = NULL`,
    );
    this.getStmt = db.prepare(`SELECT * FROM ${t} WHERE ref = ?`);
    this.expireStmt = db.prepare(`UPDATE ${t} SET t_expired = ? WHERE ref = ? AND t_expired IS NULL`);
    this.byKindStmt = db.prepare(`SELECT * FROM ${t} WHERE kind = ? AND t_expired IS NULL ORDER BY ref`);
  }

  /** Insert or refresh the entity; a previously expired ref comes back live. */
  upsert(entity: EntityInput): void {
    this.upsertStmt.run({
      ref: entity.ref,
      kind: entity.kind,
      name: entity.name ?? null,
      parentRef: entity.parentRef ?? null,
      attrs: entity.attrs == null ? null : JSON.stringify(entity.attrs),
      tValid: entity.tValid ?? nowIso(),
    });
  }

  get(ref: string): EntityRow | undefined {
    const raw = this.getStmt.get(ref) as RawEntityRow | undefined;
    return raw === undefined ? undefined : toEntityRow(raw);
  }

  expire(ref: string, at: string = nowIso()): boolean {
    return this.expireStmt.run(at, ref).changes === 1;
  }

  listByKind(kind: string): EntityRow[] {
    return (this.byKindStmt.all(kind) as RawEntityRow[]).map(toEntityRow);
  }
}
