import { quoteIdent, type Db } from "../open.js";

/**
 * Full-text search without storing the text. `searchable_span` holds only a
 * locator into the source (a byte range in a transcript, a file, a blob); the
 * FTS5 table is genuinely contentless (`content=''`), so text is streamed in
 * at index time and discarded. Reads MUST join through the span table: a
 * contentless FTS5 table cannot delete rows without their original text, so
 * purges strand FTS rows, and the join is what makes those orphans invisible.
 */
export interface SpanFtsOptions {
  /** Base name; tables are `<name>_span` and `<name>_fts`. */
  name?: string;
}

function names(name: string): { span: string; fts: string } {
  return { span: quoteIdent(`${name}_span`), fts: quoteIdent(`${name}_fts`) };
}

export function spanFtsTablesDdl({ name = "search" }: SpanFtsOptions = {}): string {
  const { span, fts } = names(name);
  return `
    CREATE TABLE IF NOT EXISTS ${span} (
      span_id     INTEGER PRIMARY KEY,
      owner_ref   TEXT NOT NULL,
      field       TEXT NOT NULL,
      source_id   INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      UNIQUE (owner_ref, field, source_id, byte_offset)
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_span_owner`)} ON ${span}(owner_ref);
    CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(text, content='');
  `;
}

export interface SpanInput {
  /** The entity this text belongs to, e.g. `session:abc`. */
  ownerRef: string;
  /** Which part of the owner, e.g. `prompt` or `tool_result`. */
  field: string;
  /** Transcript or file id the byte range is relative to. */
  sourceId: number;
  byteOffset: number;
  byteLength: number;
}

export interface SpanHit extends SpanInput {
  spanId: number;
  /** FTS5 bm25 rank; lower is better. */
  rank: number;
}

interface RawSpanHit {
  span_id: number;
  owner_ref: string;
  field: string;
  source_id: number;
  byte_offset: number;
  byte_length: number;
  rank: number;
}

export class SpanFtsTables {
  private readonly insertSpan;
  private readonly findSpan;
  private readonly insertFts;
  private readonly searchStmt;
  private readonly deleteAllFts;
  private readonly deleteSpansStmt;
  private readonly countSpans;
  private readonly countFts;

  constructor(db: Db, { name = "search" }: SpanFtsOptions = {}) {
    const { span, fts } = names(name);
    this.insertSpan = db.prepare(
      `INSERT INTO ${span} (owner_ref, field, source_id, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_ref, field, source_id, byte_offset) DO NOTHING`,
    );
    this.findSpan = db.prepare(
      `SELECT span_id FROM ${span} WHERE owner_ref = ? AND field = ? AND source_id = ? AND byte_offset = ?`,
    );
    this.insertFts = db.prepare(`INSERT INTO ${fts} (rowid, text) VALUES (?, ?)`);
    this.searchStmt = db.prepare(
      `SELECT s.span_id, s.owner_ref, s.field, s.source_id, s.byte_offset, s.byte_length, f.rank
       FROM ${fts} f JOIN ${span} s ON s.span_id = f.rowid
       WHERE ${fts} MATCH ? ORDER BY f.rank LIMIT ?`,
    );
    this.deleteAllFts = db.prepare(`INSERT INTO ${fts}(${fts}) VALUES ('delete-all')`);
    this.deleteSpansStmt = db.prepare(`DELETE FROM ${span} WHERE owner_ref = ?`);
    this.countSpans = db.prepare(`SELECT count(*) AS n FROM ${span}`);
    this.countFts = db.prepare(`SELECT count(*) AS n FROM ${fts}`);
  }

  /** Index `text` for a span, storing only the locator. Re-indexing the same span is a no-op. Returns the span id. */
  index(span: SpanInput, text: string): number {
    const inserted = this.insertSpan.run(span.ownerRef, span.field, span.sourceId, span.byteOffset, span.byteLength);
    const spanId = (this.findSpan.get(span.ownerRef, span.field, span.sourceId, span.byteOffset) as { span_id: number }).span_id;
    if (inserted.changes === 1) this.insertFts.run(spanId, text);
    return spanId;
  }

  /** FTS5 MATCH, joined through the span table so stranded FTS rows never surface. */
  search(query: string, limit = 50): SpanHit[] {
    return (this.searchStmt.all(query, limit) as RawSpanHit[]).map((r) => ({
      spanId: r.span_id,
      ownerRef: r.owner_ref,
      field: r.field,
      sourceId: r.source_id,
      byteOffset: r.byte_offset,
      byteLength: r.byte_length,
      rank: r.rank,
    }));
  }

  /** Drop an owner's spans. Their FTS rows become orphans until `rebuild`; the join hides them. */
  purgeOwner(ownerRef: string): number {
    return this.deleteSpansStmt.run(ownerRef).changes;
  }

  /** Fraction of FTS rows with no span behind them; a high value means it is time to rebuild. */
  orphanRatio(): number {
    const fts = (this.countFts.get() as { n: number }).n;
    if (fts === 0) return 0;
    const spans = (this.countSpans.get() as { n: number }).n;
    return Math.max(0, fts - spans) / fts;
  }

  /** Empty the FTS index. The caller re-streams text through `index` for every surviving span. */
  clearIndex(): void {
    this.deleteAllFts.run();
  }
}
