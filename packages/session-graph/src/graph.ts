import { EdgeTable, SpanFtsTables, WatermarkTable, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { DERIVED_TABLES, KIT, MIGRATIONS } from "./schema.js";

/** One open session graph: the connection plus the kit helpers bound to its tables. */
export interface SessionGraph {
  db: Db;
  transcripts: WatermarkTable;
  edges: EdgeTable;
  spans: SpanFtsTables;
}

export function openSessionGraph(dbPath: string): SessionGraph {
  const db = openDatabase(dbPath);
  runMigrations(db, MIGRATIONS);
  return {
    db,
    transcripts: new WatermarkTable(db, { name: KIT.watermark }),
    edges: new EdgeTable(db, { name: KIT.edge }),
    spans: new SpanFtsTables(db, { name: KIT.spanFts }),
  };
}

/**
 * Clear every derived row and rewind all watermarks so the next refresh
 * rebuilds from byte 0. Rewinding alone is not enough: the accumulating
 * upserts would add a second copy of every count.
 */
export function resetIndex(graph: SessionGraph): void {
  graph.db.transaction(() => {
    for (const table of DERIVED_TABLES) graph.db.exec(`DELETE FROM "${table}"`);
    graph.spans.clearIndex();
    for (const row of graph.transcripts.list()) graph.transcripts.rewind(row.sourceKey);
  })();
}

export function allSessionIds(graph: SessionGraph): string[] {
  return (graph.db.prepare("SELECT session_id FROM session").all() as { session_id: string }[]).map((r) => r.session_id);
}
