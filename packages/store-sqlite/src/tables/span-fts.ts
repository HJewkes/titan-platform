import type Database from "better-sqlite3";
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
  /**
   * Create the FTS table with `contentless_delete=1` (SQLite 3.43+), so purges
   * delete FTS rows instead of stranding them. Default false: the table and its
   * orphan behaviour stay as they were.
   */
  contentlessDelete?: boolean;
}

const MIN_CONTENTLESS_DELETE = [3, 43];

function supportsContentlessDelete(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_CONTENTLESS_DELETE[0]! || (major === MIN_CONTENTLESS_DELETE[0] && minor >= MIN_CONTENTLESS_DELETE[1]!);
}

function names(name: string): { span: string; fts: string } {
  return { span: quoteIdent(`${name}_span`), fts: quoteIdent(`${name}_fts`) };
}

export function spanFtsTablesDdl({ name = "search", contentlessDelete = false }: SpanFtsOptions = {}): string {
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
    CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(text, content=''${contentlessDelete ? ", contentless_delete=1" : ""});
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

/**
 * Narrow a search to one class of owner, so one class cannot flood a result set.
 *
 * A span table that holds several entity classes holds them in wildly different
 * volumes. Measured on active-work's graph: 92,713 transcript spans against
 * 1,569 note spans, 59 to 1. Ranking one pooled query returns transcript
 * chatter and the notes never surface, so the fix is a separate ranked list per
 * class, which needs a way to ask for one class.
 *
 * `ownerPrefix` and `fields` are both needed, not either. active-work keys both
 * a mined transcript and a workspace session record under `session:`, and they
 * are separable only by field — `body` is the record, `prompt` and the
 * `tool_*` fields are the transcript. A prefix-only filter would put 92,713
 * transcript spans into the records' list and look like it was working.
 */
export interface SpanScope {
  /** Match owners whose ref starts with this, e.g. `note:`. A range scan, so the owner index applies. */
  ownerPrefix?: string;
  /** Match only these fields, e.g. `["title", "body"]`. Empty means no field matches. */
  fields?: string[];
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

/** The string just past the prefix, so a prefix match is a half-open range the index can serve. */
function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/** An empty prefix means "every owner", which is what omitting it already means. */
function hasPrefix(scope: SpanScope): boolean {
  return scope.ownerPrefix !== undefined && scope.ownerPrefix.length > 0;
}

/** Bind values for `scopedStatement`'s predicates, in the order it writes them. */
function scopeValues(scope: SpanScope): (string | number)[] {
  const values: (string | number)[] = [];
  if (hasPrefix(scope)) values.push(scope.ownerPrefix!, prefixUpperBound(scope.ownerPrefix!));
  if (scope.fields !== undefined) values.push(...scope.fields);
  return values;
}

export class SpanFtsTables {
  private readonly db: Db;
  private readonly tableNames: { span: string; fts: string };
  private readonly insertSpan;
  private readonly findSpan;
  private readonly insertFts;
  private readonly hasFtsRow;
  private readonly searchStmt;
  /** One prepared statement per scope shape, since the predicate list varies. */
  private readonly scopedSearchStmts = new Map<string, Database.Statement<unknown[], RawSpanHit>>();
  private readonly deleteAllFts;
  private readonly deleteSpansStmt;
  private readonly deleteSourceSpansStmt;
  private readonly purgeOwnerTxn;
  private readonly purgeSourceTxn;
  private readonly countSpans;
  private readonly countFts;
  private readonly indexTxn;

  constructor(db: Db, { name = "search", contentlessDelete = false }: SpanFtsOptions = {}) {
    const { span, fts } = names(name);
    if (contentlessDelete) {
      const version = db.prepare("SELECT sqlite_version()").pluck().get();
      if (typeof version !== "string" || !supportsContentlessDelete(version)) {
        throw new Error(
          `contentlessDelete needs SQLite ${MIN_CONTENTLESS_DELETE.join(".")} or later; this build is ${String(version)}`,
        );
      }
    }
    this.db = db;
    this.tableNames = { span, fts };
    // Contentless FTS retains orphan rowids after a purge. Never reuse one: old
    // tokens would otherwise become visible through an unrelated replacement span.
    this.insertSpan = db.prepare(
      `INSERT INTO ${span} (span_id, owner_ref, field, source_id, byte_offset, byte_length)
       VALUES ((SELECT MAX(id) + 1 FROM (SELECT COALESCE(MAX(span_id), 0) AS id FROM ${span} UNION ALL SELECT COALESCE(MAX(rowid), 0) AS id FROM ${fts})), ?, ?, ?, ?, ?)
       ON CONFLICT (owner_ref, field, source_id, byte_offset) DO NOTHING`,
    );
    this.findSpan = db.prepare<[string, string, number, number], { span_id: number }>(
      `SELECT span_id FROM ${span} WHERE owner_ref = ? AND field = ? AND source_id = ? AND byte_offset = ?`,
    );
    this.insertFts = db.prepare(`INSERT INTO ${fts} (rowid, text) VALUES (?, ?)`);
    this.hasFtsRow = db.prepare(`SELECT 1 FROM ${fts} WHERE rowid = ?`);
    this.searchStmt = db.prepare<[string, number], RawSpanHit>(
      `SELECT s.span_id, s.owner_ref, s.field, s.source_id, s.byte_offset, s.byte_length, f.rank
       FROM ${fts} f JOIN ${span} s ON s.span_id = f.rowid
       WHERE ${fts} MATCH ? ORDER BY f.rank LIMIT ?`,
    );
    this.deleteAllFts = db.prepare(`INSERT INTO ${fts}(${fts}) VALUES ('delete-all')`);
    this.deleteSpansStmt = db.prepare(`DELETE FROM ${span} WHERE owner_ref = ?`);
    this.deleteSourceSpansStmt = db.prepare(`DELETE FROM ${span} WHERE source_id = ?`);
    const deleteOwnerFts = db.prepare(`DELETE FROM ${fts} WHERE rowid IN (SELECT span_id FROM ${span} WHERE owner_ref = ?)`);
    const deleteSourceFts = db.prepare(`DELETE FROM ${fts} WHERE rowid IN (SELECT span_id FROM ${span} WHERE source_id = ?)`);
    // FTS rows go first: once the spans are gone there is no way to find their rowids.
    this.purgeOwnerTxn = db.transaction((ownerRef: string): number => {
      if (contentlessDelete) deleteOwnerFts.run(ownerRef);
      return this.deleteSpansStmt.run(ownerRef).changes;
    });
    this.purgeSourceTxn = db.transaction((sourceId: number): number => {
      if (contentlessDelete) deleteSourceFts.run(sourceId);
      return this.deleteSourceSpansStmt.run(sourceId).changes;
    });
    this.countSpans = db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${span}`);
    this.countFts = db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${fts}`);
    // One transaction, so a failed FTS insert cannot strand a span row with no FTS row.
    this.indexTxn = db.transaction((span: SpanInput, text: string): number => {
      const inserted = this.insertSpan.run(span.ownerRef, span.field, span.sourceId, span.byteOffset, span.byteLength);
      const found = this.findSpan.get(span.ownerRef, span.field, span.sourceId, span.byteOffset);
      if (found === undefined) throw new Error("span row missing right after insert");
      const spanId = found.span_id;
      if (inserted.changes === 1 || this.hasFtsRow.get(spanId) === undefined) this.insertFts.run(spanId, text);
      return spanId;
    });
  }

  /**
   * Index `text` for a span, storing only the locator. Returns the span id.
   *
   * Re-indexing a span that still has its FTS row is a no-op; re-indexing one
   * whose row `clearIndex` removed puts the row back, which is what makes
   * clear-then-re-stream a rebuild. Only the conflict path pays the rowid probe.
   */
  index(span: SpanInput, text: string): number {
    return this.indexTxn(span, text);
  }

  /**
   * FTS5 MATCH, joined through the span table so stranded FTS rows never surface.
   *
   * `scope` narrows to one class of owner; `limit` is applied after it, so a
   * scoped search returns its own top-N rather than whatever survives the
   * filter out of a global top-N.
   */
  search(query: string, limit = 50, scope?: SpanScope): SpanHit[] {
    const rows = scope ? this.scopedStatement(scope).all([query, ...scopeValues(scope), limit]) : this.searchStmt.all(query, limit);
    return rows.map((r) => ({
      spanId: r.span_id,
      ownerRef: r.owner_ref,
      field: r.field,
      sourceId: r.source_id,
      byteOffset: r.byte_offset,
      byteLength: r.byte_length,
      rank: r.rank,
    }));
  }

  /**
   * Prepared statement for one scope shape, cached.
   *
   * Cached by shape rather than by values, because a product registers a fixed
   * handful of class retrievers and then queries them for the life of the
   * process. Keyed on the field *count* and whether a prefix is present, which
   * is everything that changes the SQL.
   */
  private scopedStatement(scope: SpanScope): Database.Statement<unknown[], RawSpanHit> {
    const fieldCount = scope.fields?.length ?? 0;
    const key = `${hasPrefix(scope) ? 1 : 0}:${scope.fields === undefined ? "all" : fieldCount}`;
    const cached = this.scopedSearchStmts.get(key);
    if (cached) return cached;

    const { span, fts } = this.tableNames;
    const predicates = [`${fts} MATCH ?`];
    // A half-open range rather than LIKE or GLOB, so the owner index applies.
    if (hasPrefix(scope)) predicates.push("s.owner_ref >= ? AND s.owner_ref < ?");
    if (scope.fields !== undefined) {
      predicates.push(fieldCount === 0 ? "0" : `s.field IN (${new Array(fieldCount).fill("?").join(", ")})`);
    }
    const statement = this.db.prepare<unknown[], RawSpanHit>(
      `SELECT s.span_id, s.owner_ref, s.field, s.source_id, s.byte_offset, s.byte_length, f.rank
       FROM ${fts} f JOIN ${span} s ON s.span_id = f.rowid
       WHERE ${predicates.join(" AND ")} ORDER BY f.rank LIMIT ?`,
    );
    this.scopedSearchStmts.set(key, statement);
    return statement;
  }

  /**
   * Drop an owner's spans. Without `contentlessDelete` their FTS rows become
   * orphans, hidden by the join, until `clearIndex` and a re-stream.
   */
  purgeOwner(ownerRef: string): number {
    return this.purgeOwnerTxn(ownerRef);
  }

  /** Drop every span of one source (transcript or file), with the same FTS behaviour as `purgeOwner`. */
  purgeSource(sourceId: number): number {
    return this.purgeSourceTxn(sourceId);
  }

  /** Fraction of FTS rows with no span behind them; a high value means it is time to `clearIndex` and re-stream. */
  orphanRatio(): number {
    const fts = this.countFts.get()?.n ?? 0;
    if (fts === 0) return 0;
    const spans = this.countSpans.get()?.n ?? 0;
    return Math.max(0, fts - spans) / fts;
  }

  /**
   * Empty the FTS index, keeping every span row. Re-streaming each surviving
   * span's text through `index` then rebuilds it with the same span ids.
   */
  clearIndex(): void {
    this.deleteAllFts.run();
  }
}
