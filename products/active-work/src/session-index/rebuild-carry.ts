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
 *
 * `transcript` comes first, with its `source_id`s, because preserved `fact`,
 * `request` and `compaction` rows name their transcript by that id. A fresh file
 * would number only the files still on disk, so a pruned transcript's id would
 * belong to a live one and its replayed rows would collide or point at the wrong
 * file. Carried rows are rewound as `resetIndex` rewinds them, so the first pass
 * re-reads every file under the id it already had.
 */
interface CarrySpec {
  table: string;
  where?: string;
  /** SQL expressions that replace a column's carried value. */
  override?: Record<string, string>;
}

const CARRIED: CarrySpec[] = [
  { table: 'transcript', override: { last_offset: '0', prefix_hash: 'NULL' } },
  { table: 'preserved_row' },
  { table: 'pr' },
  { table: 'pr_review', where: "surface <> 'chat'" },
];

function columnsOf(db: Database.Database, table: string): string[] {
  const rows = db.prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)').all(table);
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
  spec: CarrySpec,
): number {
  const target = new Set(columnsOf(to, spec.table));
  const columns = columnsOf(from, spec.table).filter((column) => target.has(column));
  const names = columns.map((column) => `"${column}"`).join(', ');
  const insert = to.prepare(
    `INSERT OR IGNORE INTO "${spec.table}" (${names}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  const selected = columns.map((column) => spec.override?.[column] ?? `"${column}"`).join(', ');
  const where = spec.where ? ` WHERE ${spec.where}` : '';
  const rows = from.prepare<[], unknown[]>(`SELECT ${selected} FROM "${spec.table}"${where}`).raw();
  let carried = 0;
  for (const row of rows.iterate()) carried += insert.run(...row).changes;
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

const TOTAL_KEYS = [
  'sessions',
  'turns',
  'facts',
  'compactions',
  'permissionPhases',
  'humanEdits',
  'sessionOrigins',
  'turnDurationMs',
  'toolCalls',
  'requests',
  'requestCount',
  'inputTokens',
  'outputTokens',
] as const;

export type GraphTotals = Record<(typeof TOTAL_KEYS)[number], number>;

const TOTALS = `SELECT
  (SELECT COUNT(*) FROM session) AS sessions,
  (SELECT COUNT(*) FROM turn) AS turns,
  (SELECT COUNT(*) FROM fact) AS facts,
  (SELECT COUNT(*) FROM compaction) AS compactions,
  (SELECT COUNT(*) FROM permission_phase) AS permissionPhases,
  (SELECT COUNT(*) FROM human_edit) AS humanEdits,
  (SELECT COUNT(*) FROM session_origin) AS sessionOrigins,
  (SELECT COALESCE(SUM(duration_ms), 0) FROM turn) AS turnDurationMs,
  (SELECT COALESCE(SUM(tool_call_count), 0) FROM turn) AS toolCalls,
  (SELECT COUNT(*) FROM request) AS requests,
  (SELECT COALESCE(SUM(request_count), 0) FROM session_model_usage) AS requestCount,
  (SELECT COALESCE(SUM(input_tokens), 0) FROM session_model_usage) AS inputTokens,
  (SELECT COALESCE(SUM(output_tokens), 0) FROM session_model_usage) AS outputTokens`;

/**
 * Row counts of every table `preserveUnreachable` declares, and turn and token
 * totals; a rebuild that changes one has lost or invented history.
 */
export function graphTotals(dbPath: string): GraphTotals {
  const db = openGraphReadOnly(dbPath);
  try {
    const totals = db.prepare<[], GraphTotals>(TOTALS).get();
    if (!totals) throw new Error(`${dbPath}: the totals query returned no row`);
    return totals;
  } finally {
    db.close();
  }
}

export function sameTotals(a: GraphTotals, b: GraphTotals): boolean {
  return TOTAL_KEYS.every((key) => a[key] === b[key]);
}
