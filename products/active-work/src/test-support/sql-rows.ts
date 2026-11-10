export type SqlRow = Record<string, unknown>;

function isSqlRow(value: unknown): value is SqlRow {
  return typeof value === 'object' && value !== null;
}

/** Narrow the `unknown[]` a better-sqlite3 `.all()` returns to rows, without a cast. */
export function sqlRows(rows: unknown[]): SqlRow[] {
  return rows.map(sqlRow);
}

/** Narrow the `unknown` a better-sqlite3 `.get()` returns to one row, without a cast. */
export function sqlRow(row: unknown): SqlRow {
  if (!isSqlRow(row)) throw new Error('expected the query to return a row');
  return row;
}
