import {
  WatermarkTable,
  openDatabase,
  runMigrations,
  watermarkTableDdl,
  type Db,
  type Migration,
} from "@titan-design/store-sqlite";
import { LedgerRowSchema, type LedgerRow, type LedgerRowWire, type LedgerSourceName } from "./ledger.js";
import type { SourceWatermark, SourceWatermarks } from "./source.js";

const WATERMARK_TABLE = "ledger_watermark";

/** Numbered from 3000 so the ledger can share one file with other stores' migration bands. */
export const LEDGER_MIGRATIONS: Migration[] = [
  {
    version: 3000,
    name: "decider ledger rows and watermarks",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS ledger_row (
          key        TEXT PRIMARY KEY,
          source     TEXT NOT NULL,
          initiative TEXT,
          category   TEXT NOT NULL,
          outcome    TEXT,
          asked_at   TEXT,
          unclaimed  INTEGER NOT NULL DEFAULT 0,
          row_json   TEXT NOT NULL,
          written_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS ledger_row_source ON ledger_row (source, asked_at);
        CREATE INDEX IF NOT EXISTS ledger_row_initiative ON ledger_row (initiative, category);
        ${watermarkTableDdl({ name: WATERMARK_TABLE })}
      `),
  },
];

/** A row with its insertion sequence: the order rows reached the ledger, whatever their evidence time. */
export interface LedgerEntry {
  seq: number;
  row: LedgerRow;
}

export interface LedgerRowFilter {
  source?: LedgerSourceName;
  initiative?: string;
}

function cursorKey(source: string, cursor: string): string {
  return `${source}:${cursor}`;
}

/**
 * The append-only ledger: one row per key, never updated, plus a watermark per source cursor.
 * Rows are validated through `LedgerRowSchema` on the way in and on the way out.
 */
export class LedgerStore {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly watermarks;

  constructor(readonly db: Db) {
    runMigrations(db, LEDGER_MIGRATIONS);
    this.insertStmt = db.prepare(
      `INSERT INTO ledger_row (key, source, initiative, category, outcome, asked_at, unclaimed, row_json)
       VALUES (@key, @source, @initiative, @category, @outcome, @asked_at, @unclaimed, @row_json)
       ON CONFLICT (key) DO NOTHING`,
    );
    this.getStmt = db.prepare("SELECT row_json FROM ledger_row WHERE key = ?");
    this.watermarks = new WatermarkTable(db, { name: WATERMARK_TABLE });
  }

  /** Writes rows whose key is new and returns how many it wrote; a known key is left untouched. */
  append(rows: readonly LedgerRowWire[]): number {
    return this.transaction(() => rows.reduce((written, row) => written + this.insert(row), 0));
  }

  private insert(wire: LedgerRowWire): number {
    const row = LedgerRowSchema.parse(wire);
    const { key, source, initiative, category, outcome, asked_at } = row;
    const params = { key, source, initiative, category, outcome, asked_at };
    return this.insertStmt.run({ ...params, unclaimed: row.unclaimed ? 1 : 0, row_json: JSON.stringify(row) }).changes;
  }

  get(key: string): LedgerRow | undefined {
    const found = this.getStmt.get(key) as { row_json: string } | undefined;
    return found === undefined ? undefined : LedgerRowSchema.parse(JSON.parse(found.row_json));
  }

  rows(filter: LedgerRowFilter = {}): LedgerRow[] {
    const found = this.db
      .prepare(
        `SELECT row_json FROM ledger_row
          WHERE (@source IS NULL OR source = @source) AND (@initiative IS NULL OR initiative = @initiative)
          ORDER BY asked_at, key`,
      )
      .all({ source: filter.source ?? null, initiative: filter.initiative ?? null }) as { row_json: string }[];
    return found.map((r) => LedgerRowSchema.parse(JSON.parse(r.row_json)));
  }

  /** Rows inserted after `since`, in insertion order; rowid only grows because the ledger never deletes. */
  entries(since = 0): LedgerEntry[] {
    const found = this.db.prepare("SELECT rowid AS seq, row_json FROM ledger_row WHERE rowid > ? ORDER BY rowid").all(since) as {
      seq: number;
      row_json: string;
    }[];
    return found.map((r) => ({ seq: r.seq, row: LedgerRowSchema.parse(JSON.parse(r.row_json)) }));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM ledger_row").get() as { n: number }).n;
  }

  /** The stored watermarks of one source, keyed by its cursor names. */
  sourceWatermarks(source: string): Map<string, SourceWatermark> {
    const prefix = cursorKey(source, "");
    const out = new Map<string, SourceWatermark>();
    for (const w of this.watermarks.list()) {
      if (w.sourceKey.startsWith(prefix)) {
        out.set(w.sourceKey.slice(prefix.length), { offset: w.lastOffset, prefixHash: w.prefixHash });
      }
    }
    return out;
  }

  advance(source: string, watermarks: SourceWatermarks): void {
    this.transaction(() => {
      for (const [cursor, w] of watermarks) {
        const key = cursorKey(source, cursor);
        this.watermarks.ensure(key);
        this.watermarks.advance(key, { lastOffset: w.offset, prefixHash: w.prefixHash });
      }
    });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

/** Opens (creating if absent) the ledger database at `dbPath`; `:memory:` works for tests. */
export function openLedgerStore(dbPath: string): LedgerStore {
  return new LedgerStore(openDatabase(dbPath));
}
