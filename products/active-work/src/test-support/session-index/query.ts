import type Database from 'better-sqlite3';

/** Every row of a read, typed by the caller; the schema is the test's own fixture, so there is nothing to parse. */
export function selectAll<Row>(db: Database.Database, sql: string, ...params: unknown[]): Row[] {
  return db.prepare<unknown[], Row>(sql).all(...params);
}

/** The first row of a read, or undefined when the query matches nothing. */
export function selectMaybe<Row>(db: Database.Database, sql: string, ...params: unknown[]): Row | undefined {
  return db.prepare<unknown[], Row>(sql).get(...params);
}

/** The first row of a read that must match; throws so a missing row fails the test with the query. */
export function selectOne<Row>(db: Database.Database, sql: string, ...params: unknown[]): Row {
  const row = selectMaybe<Row>(db, sql, ...params);
  if (row === undefined) throw new Error(`no row for: ${sql}`);
  return row;
}
