import { createHash } from "node:crypto";
import { SQL_NOW, quoteIdent, type Db } from "../open.js";

/**
 * Content-addressed cache for anything that is a pure function of some text
 * and a model: embeddings, summaries, extracted structure. Keyed by
 * `(namespace, model, content_hash)`, so unchanged inputs across re-indexes
 * are cache hits rather than re-computation, and identical text is stored once.
 */
export interface CacheBlobOptions {
  name?: string;
}

export function cacheBlobTableDdl({ name = "cache_blob" }: CacheBlobOptions = {}): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      namespace    TEXT NOT NULL,
      model        TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      value        BLOB NOT NULL,
      meta         TEXT,
      created_at   TEXT NOT NULL DEFAULT (${SQL_NOW}),
      PRIMARY KEY (namespace, model, content_hash)
    );
  `;
}

export function contentHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface CacheKey {
  namespace: string;
  model: string;
  /** Either the raw text (hashed for you) or a precomputed `contentHash`. */
  text?: string;
  contentHash?: string;
}

export interface CacheHit {
  value: Buffer;
  meta: Record<string, unknown> | null;
}

function hashFor(key: CacheKey): string {
  if (key.contentHash !== undefined) return key.contentHash;
  if (key.text !== undefined) return contentHashOf(key.text);
  throw new Error("cache key needs text or contentHash");
}

export class CacheBlobTable {
  private readonly getStmt;
  private readonly putStmt;
  private readonly countStmt;

  constructor(db: Db, { name = "cache_blob" }: CacheBlobOptions = {}) {
    const t = quoteIdent(name);
    this.getStmt = db.prepare(`SELECT value, meta FROM ${t} WHERE namespace = ? AND model = ? AND content_hash = ?`);
    this.putStmt = db.prepare(
      `INSERT INTO ${t} (namespace, model, content_hash, value, meta) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (namespace, model, content_hash) DO NOTHING`,
    );
    this.countStmt = db.prepare(`SELECT count(*) AS n FROM ${t} WHERE namespace = ? AND model = ?`);
  }

  get(key: CacheKey): CacheHit | undefined {
    const raw = this.getStmt.get(key.namespace, key.model, hashFor(key)) as { value: Buffer; meta: string | null } | undefined;
    if (raw === undefined) return undefined;
    return { value: raw.value, meta: raw.meta === null ? null : (JSON.parse(raw.meta) as Record<string, unknown>) };
  }

  /** Store once; a second put for the same key is a no-op. Returns true when written. */
  put(key: CacheKey, value: Buffer | string, meta?: Record<string, unknown>): boolean {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const info = this.putStmt.run(key.namespace, key.model, hashFor(key), bytes, meta === undefined ? null : JSON.stringify(meta));
    return info.changes === 1;
  }

  /** Get, or compute and store. The compute runs only on a miss. */
  getOrCompute(key: CacheKey, compute: () => Buffer | string, meta?: Record<string, unknown>): Buffer {
    const hit = this.get(key);
    if (hit) return hit.value;
    const value = compute();
    this.put(key, value, meta);
    return typeof value === "string" ? Buffer.from(value, "utf8") : value;
  }

  count(namespace: string, model: string): number {
    return (this.countStmt.get(namespace, model) as { n: number }).n;
  }
}
