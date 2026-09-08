import { SQL_NOW, nowIso, quoteIdent, type Db } from "../open.js";

/**
 * Interval bi-temporal edge table: `t_valid`/`t_invalid` is when the relation
 * held in the world, `t_created`/`t_expired` is when this row was believed.
 * Corrections expire a row and insert a replacement, never delete, so history
 * stays auditable while partial indexes keep live lookups cheap. This is the
 * cross-domain outer graph; relation names are free strings by design.
 */
export interface EdgeTableOptions {
  name?: string;
}

export function edgeTableDdl({ name = "edge" }: EdgeTableOptions = {}): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      edge_id    INTEGER PRIMARY KEY,
      source_ref TEXT NOT NULL,
      relation   TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      t_valid    TEXT NOT NULL,
      t_invalid  TEXT,
      t_created  TEXT NOT NULL DEFAULT (${SQL_NOW}),
      t_expired  TEXT,
      fact_id    INTEGER,
      confidence REAL NOT NULL DEFAULT 1.0,
      attrs      TEXT
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_source`)} ON ${t}(source_ref, relation) WHERE t_expired IS NULL;
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_target`)} ON ${t}(target_ref, relation) WHERE t_expired IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_current`)} ON ${t}(source_ref, relation, target_ref) WHERE t_expired IS NULL;
  `;
}

export interface EdgeInput {
  sourceRef: string;
  relation: string;
  targetRef: string;
  tValid?: string;
  tInvalid?: string | null;
  factId?: number | null;
  confidence?: number;
  attrs?: Record<string, unknown> | null;
}

export interface EdgeRow {
  edgeId: number;
  sourceRef: string;
  relation: string;
  targetRef: string;
  tValid: string;
  tInvalid: string | null;
  tCreated: string;
  tExpired: string | null;
  factId: number | null;
  confidence: number;
  attrs: Record<string, unknown> | null;
}

interface RawEdgeRow {
  edge_id: number;
  source_ref: string;
  relation: string;
  target_ref: string;
  t_valid: string;
  t_invalid: string | null;
  t_created: string;
  t_expired: string | null;
  fact_id: number | null;
  confidence: number;
  attrs: string | null;
}

function toEdgeRow(raw: RawEdgeRow): EdgeRow {
  return {
    edgeId: raw.edge_id,
    sourceRef: raw.source_ref,
    relation: raw.relation,
    targetRef: raw.target_ref,
    tValid: raw.t_valid,
    tInvalid: raw.t_invalid,
    tCreated: raw.t_created,
    tExpired: raw.t_expired,
    factId: raw.fact_id,
    confidence: raw.confidence,
    attrs: raw.attrs === null ? null : (JSON.parse(raw.attrs) as Record<string, unknown>),
  };
}

/** Prepared helpers over one edge table. Construct once per connection. */
export class EdgeTable {
  private readonly insertStmt;
  private readonly expireStmt;
  private readonly currentStmt;
  private readonly fromStmt;
  private readonly toStmt;

  constructor(db: Db, { name = "edge" }: EdgeTableOptions = {}) {
    const t = quoteIdent(name);
    this.insertStmt = db.prepare(
      `INSERT INTO ${t} (source_ref, relation, target_ref, t_valid, t_invalid, fact_id, confidence, attrs)
       VALUES (@sourceRef, @relation, @targetRef, @tValid, @tInvalid, @factId, @confidence, @attrs)
       ON CONFLICT (source_ref, relation, target_ref) WHERE t_expired IS NULL DO NOTHING`,
    );
    this.expireStmt = db.prepare(
      `UPDATE ${t} SET t_expired = ? WHERE source_ref = ? AND relation = ? AND target_ref = ? AND t_expired IS NULL`,
    );
    this.currentStmt = db.prepare(
      `SELECT * FROM ${t} WHERE source_ref = ? AND relation = ? AND target_ref = ? AND t_expired IS NULL`,
    );
    this.fromStmt = db.prepare(`SELECT * FROM ${t} WHERE source_ref = ? AND t_expired IS NULL ORDER BY edge_id`);
    this.toStmt = db.prepare(`SELECT * FROM ${t} WHERE target_ref = ? AND t_expired IS NULL ORDER BY edge_id`);
  }

  /** Assert an edge. A live identical edge is left alone (idempotent re-ingest). Returns true when inserted. */
  assert(edge: EdgeInput): boolean {
    const info = this.insertStmt.run({
      sourceRef: edge.sourceRef,
      relation: edge.relation,
      targetRef: edge.targetRef,
      tValid: edge.tValid ?? nowIso(),
      tInvalid: edge.tInvalid ?? null,
      factId: edge.factId ?? null,
      confidence: edge.confidence ?? 1,
      attrs: edge.attrs == null ? null : JSON.stringify(edge.attrs),
    });
    return info.changes === 1;
  }

  /** Retract the current belief in an edge (invalidate, never delete). Returns true when one was live. */
  expire(sourceRef: string, relation: string, targetRef: string, at: string = nowIso()): boolean {
    return this.expireStmt.run(at, sourceRef, relation, targetRef).changes === 1;
  }

  /** Replace the live edge with a corrected one in a single step. */
  supersede(edge: EdgeInput, at: string = nowIso()): void {
    this.expire(edge.sourceRef, edge.relation, edge.targetRef, at);
    this.assert(edge);
  }

  current(sourceRef: string, relation: string, targetRef: string): EdgeRow | undefined {
    const raw = this.currentStmt.get(sourceRef, relation, targetRef) as RawEdgeRow | undefined;
    return raw === undefined ? undefined : toEdgeRow(raw);
  }

  from(sourceRef: string): EdgeRow[] {
    return (this.fromStmt.all(sourceRef) as RawEdgeRow[]).map(toEdgeRow);
  }

  to(targetRef: string): EdgeRow[] {
    return (this.toStmt.all(targetRef) as RawEdgeRow[]).map(toEdgeRow);
  }
}
