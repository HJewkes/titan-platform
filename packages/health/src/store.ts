import { openDatabase, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import { healthSampleSchema, type HealthSample, type HealthSampleInput } from "./sample.js";

/**
 * Append-only by owner decision: every probe result is kept, with no sampling and no pruning.
 * The triggers make that hold for any writer of the file, not only this module.
 */
export const HEALTH_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "health_sample append-only",
    up: (db) =>
      db.exec(`
        CREATE TABLE health_sample (
          id         INTEGER PRIMARY KEY,
          ts         TEXT NOT NULL,
          ts_ms      INTEGER NOT NULL,
          target     TEXT NOT NULL,
          kind       TEXT NOT NULL,
          status     TEXT NOT NULL CHECK (status IN ('pass','warn','fail','unknown')),
          latency_ms REAL,
          observed   TEXT,
          output     TEXT,
          source     TEXT NOT NULL DEFAULT 'probe',
          dedup_key  TEXT UNIQUE
        );
        CREATE INDEX health_sample_target_ts ON health_sample (target, ts_ms);
        CREATE TRIGGER health_sample_no_update BEFORE UPDATE ON health_sample
          BEGIN SELECT RAISE(ABORT, 'health_sample is append-only'); END;
        CREATE TRIGGER health_sample_no_delete BEFORE DELETE ON health_sample
          BEGIN SELECT RAISE(ABORT, 'health_sample is append-only'); END;
      `),
  },
];

const SCHEMA_VERSION = Math.max(...HEALTH_MIGRATIONS.map((m) => m.version));

export interface HealthStoreOptions {
  /** A reader such as `titan health uptime` opens read-only and never migrates. */
  readonly?: boolean;
}

/** Opens (creating and migrating unless read-only) a health store; `:memory:` works for tests. */
export function openHealthStore(dbPath: string, options: HealthStoreOptions = {}): Db {
  const db = openDatabase(dbPath, { readonly: options.readonly, schemaVersion: SCHEMA_VERSION });
  if (!options.readonly) runMigrations(db, HEALTH_MIGRATIONS);
  return db;
}

const INSERT_SQL = `
  INSERT INTO health_sample (ts, ts_ms, target, kind, status, latency_ms, observed, output, source, dedup_key)
  VALUES (@ts, @ts_ms, @target, @kind, @status, @latency_ms, @observed, @output, @source, @dedup_key)`;

// Only import rows carry a dedup key, so a probe row is never ignored: UNIQUE does not compare NULLs.
const INSERT_DEDUP_SQL = INSERT_SQL.replace("INSERT INTO", "INSERT OR IGNORE INTO");

/**
 * Validates every row first, then writes them all in one transaction, so a tick costs one commit
 * and a bad row stores nothing. Returns how many rows were written; a known dedup key is skipped.
 */
export function appendSamples(db: Db, samples: readonly HealthSampleInput[]): number {
  const rows = samples.map((input) => toRow(healthSampleSchema.parse(input)));
  const insert = db.prepare(INSERT_SQL);
  const insertDedup = db.prepare(INSERT_DEDUP_SQL);
  const writeAll = db.transaction(() =>
    rows.reduce((written, row) => written + (row.dedup_key === null ? insert : insertDedup).run(row).changes, 0),
  );
  return writeAll();
}

interface SampleRow {
  ts: string;
  ts_ms: number;
  target: string;
  kind: string;
  status: HealthSample["status"];
  latency_ms: number | null;
  observed: string | null;
  output: string | null;
  source: string;
  dedup_key: string | null;
}

function toRow(sample: HealthSample): SampleRow {
  return {
    ts: sample.ts,
    ts_ms: Date.parse(sample.ts),
    target: sample.target,
    kind: sample.kind,
    status: sample.status,
    latency_ms: sample.latencyMs ?? null,
    observed: sample.observed === undefined ? null : JSON.stringify(sample.observed),
    output: sample.output ?? null,
    source: sample.source,
    dedup_key: sample.dedupKey ?? null,
  };
}

function fromRow(row: SampleRow): HealthSample {
  return {
    ts: row.ts,
    target: row.target,
    kind: row.kind,
    status: row.status,
    source: row.source,
    ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
    ...(row.observed === null ? {} : { observed: JSON.parse(row.observed) as Record<string, unknown> }),
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.dedup_key === null ? {} : { dedupKey: row.dedup_key }),
  };
}

/** The target's samples with `from <= ts < to`, oldest first. */
export function readSamples(db: Db, target: string, from: Date, to: Date): HealthSample[] {
  const rows = db
    .prepare("SELECT * FROM health_sample WHERE target = ? AND ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms, id")
    .all(target, from.getTime(), to.getTime()) as SampleRow[];
  return rows.map(fromRow);
}

export interface HealthStoreStats {
  rows: number;
  /** Main database pages only; the WAL file is transient and checkpointed back into them. */
  bytes: number;
  oldestTs: string | null;
  newestTs: string | null;
}

/** Growth is unbounded by design, so the store reports its own size for `titan health cost`. */
export function storeStats(db: Db): HealthStoreStats {
  const counts = db.prepare("SELECT COUNT(*) AS n, MIN(ts_ms) AS oldest, MAX(ts_ms) AS newest FROM health_sample").get() as {
    n: number;
    oldest: number | null;
    newest: number | null;
  };
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  return {
    rows: counts.n,
    bytes: pageCount * pageSize,
    oldestTs: counts.oldest === null ? null : new Date(counts.oldest).toISOString(),
    newestTs: counts.newest === null ? null : new Date(counts.newest).toISOString(),
  };
}
