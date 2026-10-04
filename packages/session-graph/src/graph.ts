import { EdgeTable, MIGRATION_TABLE_NAME, SpanFtsTables, WatermarkTable, hasTable, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { ensureNormalizedSchema } from "./normalized-schema.js";
import { KIT, MIGRATIONS, derivedTables } from "./schema.js";

/** One open session graph: the connection plus the kit helpers bound to its tables. */
export interface SessionGraph {
  db: Db;
  transcripts: WatermarkTable;
  edges: EdgeTable;
  spans: SpanFtsTables;
}

export interface OpenSessionGraphOptions {
  /**
   * The highest migration version the caller owns, checked before any migration runs.
   * A product layering its own tables on this graph passes its own top version, not this
   * package's: `MIGRATIONS` here is one band of a shared database, never the top of it.
   */
  schemaVersion?: number;
  /**
   * Open a graph another process owns without writing to it: no migrations run, and
   * the graph must already carry every migration this package declares.
   */
  readonly?: boolean;
  /** Keep the `normalized_*` tables the Codex path reads and writes. Off by default: a graph holds none unless asked. Ignored when read-only. */
  normalized?: boolean;
}

export class SessionGraphNotMigratedError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`the graph does not carry session-graph migrations ${missing.join(", ")}; let its owner migrate it before opening it read-only`);
    this.name = "SessionGraphNotMigratedError";
  }
}

export function openSessionGraph(dbPath: string, options: OpenSessionGraphOptions = {}): SessionGraph {
  const db = openDatabase(dbPath, { schemaVersion: options.schemaVersion, readonly: options.readonly });
  if (options.readonly) assertMigratedOrClose(db);
  else runMigrations(db, MIGRATIONS);
  if (options.normalized && !options.readonly) ensureNormalizedSchema(db);
  return {
    db,
    transcripts: new WatermarkTable(db, { name: KIT.watermark }),
    edges: new EdgeTable(db, { name: KIT.edge }),
    spans: new SpanFtsTables(db, { name: KIT.spanFts }),
  };
}

function assertMigratedOrClose(db: Db): void {
  const applied = appliedNames(db);
  const missing = MIGRATIONS.filter((m) => applied.get(m.version) !== m.name).map((m) => `${m.version} (${m.name})`);
  if (missing.length === 0) return;
  db.close();
  throw new SessionGraphNotMigratedError(missing);
}

/** Reads without creating the migration table, which a read-only connection cannot do. */
function appliedNames(db: Db): Map<number, string | null> {
  if (!hasTable(db, MIGRATION_TABLE_NAME)) return new Map();
  const rows = db.prepare(`SELECT version, name FROM ${MIGRATION_TABLE_NAME}`).all() as { version: number; name: string | null }[];
  return new Map(rows.map((r) => [r.version, r.name]));
}

/**
 * Clear every derived row and rewind all watermarks so the next refresh
 * rebuilds from byte 0. Rewinding alone is not enough: the accumulating
 * upserts would add a second copy of every count.
 */
export function resetIndex(graph: SessionGraph): void {
  graph.db.transaction(() => {
    for (const table of derivedTables(graph.db)) graph.db.exec(`DELETE FROM "${table}"`);
    graph.spans.clearIndex();
    for (const row of graph.transcripts.list()) graph.transcripts.rewind(row.sourceKey);
  })();
}

export function allSessionIds(graph: SessionGraph): string[] {
  return (graph.db.prepare("SELECT session_id FROM session").all() as { session_id: string }[]).map((r) => r.session_id);
}
