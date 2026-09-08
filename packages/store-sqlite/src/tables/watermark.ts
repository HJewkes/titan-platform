import { SQL_NOW, quoteIdent, type Db } from "../open.js";

/**
 * Incremental-ingest bookkeeping for any append-mostly source: where the reader
 * stopped, a hash of what it already consumed (so a rewrite is detected rather
 * than silently re-read from the wrong offset), and the size/mtime/content-hash
 * triple that makes "source gone or altered" a reportable state.
 */
export type WatermarkStatus = "ok" | "missing" | "hash_mismatch" | "quarantined";

export interface WatermarkOptions {
  name?: string;
}

export function watermarkTableDdl({ name = "watermark" }: WatermarkOptions = {}): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      source_id       INTEGER PRIMARY KEY,
      source_key      TEXT NOT NULL UNIQUE,
      last_offset     INTEGER NOT NULL DEFAULT 0,
      prefix_hash     TEXT,
      last_indexed_at TEXT,
      file_size       INTEGER,
      file_mtime      TEXT,
      content_hash    TEXT,
      status          TEXT NOT NULL DEFAULT 'ok',
      status_reason   TEXT,
      created_at      TEXT NOT NULL DEFAULT (${SQL_NOW})
    );
  `;
}

export interface WatermarkRow {
  sourceId: number;
  sourceKey: string;
  lastOffset: number;
  prefixHash: string | null;
  lastIndexedAt: string | null;
  fileSize: number | null;
  fileMtime: string | null;
  contentHash: string | null;
  status: WatermarkStatus;
  statusReason: string | null;
}

interface RawWatermarkRow {
  source_id: number;
  source_key: string;
  last_offset: number;
  prefix_hash: string | null;
  last_indexed_at: string | null;
  file_size: number | null;
  file_mtime: string | null;
  content_hash: string | null;
  status: WatermarkStatus;
  status_reason: string | null;
}

function toRow(raw: RawWatermarkRow): WatermarkRow {
  return {
    sourceId: raw.source_id,
    sourceKey: raw.source_key,
    lastOffset: raw.last_offset,
    prefixHash: raw.prefix_hash,
    lastIndexedAt: raw.last_indexed_at,
    fileSize: raw.file_size,
    fileMtime: raw.file_mtime,
    contentHash: raw.content_hash,
    status: raw.status,
    statusReason: raw.status_reason,
  };
}

export interface WatermarkAdvance {
  lastOffset: number;
  prefixHash?: string | null;
  fileSize?: number | null;
  fileMtime?: string | null;
  /** Null keeps any previously stored hash; computing it is O(file) and optional. */
  contentHash?: string | null;
}

export class WatermarkTable {
  private readonly ensureStmt;
  private readonly getStmt;
  private readonly advanceStmt;
  private readonly statusStmt;
  private readonly rewindStmt;
  private readonly listStmt;

  constructor(db: Db, { name = "watermark" }: WatermarkOptions = {}) {
    const t = quoteIdent(name);
    this.ensureStmt = db.prepare(`INSERT INTO ${t} (source_key) VALUES (?) ON CONFLICT (source_key) DO NOTHING`);
    this.getStmt = db.prepare(`SELECT * FROM ${t} WHERE source_key = ?`);
    this.advanceStmt = db.prepare(
      `UPDATE ${t} SET last_offset = @lastOffset, prefix_hash = @prefixHash, last_indexed_at = ${SQL_NOW},
         file_size = @fileSize, file_mtime = @fileMtime, content_hash = COALESCE(@contentHash, content_hash),
         status = 'ok', status_reason = NULL
       WHERE source_key = @sourceKey`,
    );
    this.statusStmt = db.prepare(`UPDATE ${t} SET status = ?, status_reason = ? WHERE source_key = ?`);
    this.rewindStmt = db.prepare(`UPDATE ${t} SET last_offset = 0, prefix_hash = NULL WHERE source_key = ?`);
    this.listStmt = db.prepare(`SELECT * FROM ${t} ORDER BY source_id`);
  }

  /** The row for a source, created at offset 0 on first sight. The id is stable for the table's life. */
  ensure(sourceKey: string): WatermarkRow {
    this.ensureStmt.run(sourceKey);
    return toRow(this.getStmt.get(sourceKey) as RawWatermarkRow);
  }

  get(sourceKey: string): WatermarkRow | undefined {
    const raw = this.getStmt.get(sourceKey) as RawWatermarkRow | undefined;
    return raw === undefined ? undefined : toRow(raw);
  }

  advance(sourceKey: string, update: WatermarkAdvance): void {
    this.advanceStmt.run({
      sourceKey,
      lastOffset: update.lastOffset,
      prefixHash: update.prefixHash ?? null,
      fileSize: update.fileSize ?? null,
      fileMtime: update.fileMtime ?? null,
      contentHash: update.contentHash ?? null,
    });
  }

  /** Back to byte 0, for a source that was rewritten rather than appended to. */
  rewind(sourceKey: string): void {
    this.rewindStmt.run(sourceKey);
  }

  markStatus(sourceKey: string, status: WatermarkStatus, reason: string | null = null): void {
    this.statusStmt.run(status, reason, sourceKey);
  }

  list(): WatermarkRow[] {
    return (this.listStmt.all() as RawWatermarkRow[]).map(toRow);
  }
}
