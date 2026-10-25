import type Database from 'better-sqlite3';
import { openGraphReadOnly } from './graph.js';

/**
 * What `miner rebuild` copies from the live graph into the fresh file, and the
 * totals it compares before the swap (TP-882).
 *
 * A fresh file re-derives everything the corpus holds. These rows it cannot:
 * `preserved_row` is history whose transcripts are gone, the forge columns of
 * `pr` would otherwise cost one `gh` call per PR to re-learn, and a review
 * verdict from GitHub has no transcript line behind it.
 */
const CARRIED: { table: string; where?: string }[] = [
  { table: 'preserved_row' },
  { table: 'pr' },
  { table: 'pr_review', where: "surface <> 'chat'" },
];

function columnsOf(db: Database.Database, table: string): string[] {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * Whole rows, so the transcript pass that follows finds each PR already there:
 * its upsert fills only a missing title or url and leaves the forge columns be.
 * The column list is the two files' common columns, because `pr` gains its
 * columns by `ALTER TABLE` and their order differs between an old and a new file.
 */
function carryTable(
  from: Database.Database,
  to: Database.Database,
  spec: { table: string; where?: string },
): number {
  const target = new Set(columnsOf(to, spec.table));
  const columns = columnsOf(from, spec.table).filter((column) => target.has(column));
  const names = columns.map((column) => `"${column}"`).join(', ');
  const insert = to.prepare(
    `INSERT OR IGNORE INTO "${spec.table}" (${names}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  const where = spec.where ? ` WHERE ${spec.where}` : '';
  const rows = from.prepare(`SELECT ${names} FROM "${spec.table}"${where}`).raw();
  let carried = 0;
  for (const row of rows.iterate() as Iterable<unknown[]>) carried += insert.run(...row).changes;
  return carried;
}

/** Idempotent, so a `--resume` may run it again over a half-built file. */
export function carryNonDerivable(
  from: Database.Database,
  to: Database.Database,
): Record<string, number> {
  const carried: Record<string, number> = {};
  to.transaction(() => {
    for (const spec of CARRIED) carried[spec.table] = carryTable(from, to, spec);
  })();
  return carried;
}

export interface GraphTotals {
  turns: number;
  turnDurationMs: number;
  toolCalls: number;
  requests: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
}

const TOTALS = `SELECT
  (SELECT COUNT(*) FROM turn) AS turns,
  (SELECT COALESCE(SUM(duration_ms), 0) FROM turn) AS turnDurationMs,
  (SELECT COALESCE(SUM(tool_call_count), 0) FROM turn) AS toolCalls,
  (SELECT COUNT(*) FROM request) AS requests,
  (SELECT COALESCE(SUM(request_count), 0) FROM session_model_usage) AS requestCount,
  (SELECT COALESCE(SUM(input_tokens), 0) FROM session_model_usage) AS inputTokens,
  (SELECT COALESCE(SUM(output_tokens), 0) FROM session_model_usage) AS outputTokens`;

/** Turn and request totals; a rebuild that changes one has lost or invented history. */
export function graphTotals(dbPath: string): GraphTotals {
  const db = openGraphReadOnly(dbPath);
  try {
    return db.prepare(TOTALS).get() as GraphTotals;
  } finally {
    db.close();
  }
}

export function sameTotals(a: GraphTotals, b: GraphTotals): boolean {
  return (Object.keys(a) as (keyof GraphTotals)[]).every((key) => a[key] === b[key]);
}
