import type { WorkspaceGraph } from './graph.js';

/** Offset advance per transcript row; a row whose offset fell was re-read from byte 0. */
export function bytesAdvanced(before: Map<number, number>, after: Map<number, number>): number {
  let total = 0;
  for (const [sourceId, offset] of after) {
    const was = before.get(sourceId) ?? 0;
    total += offset >= was ? offset - was : offset;
  }
  return total;
}

type Db = WorkspaceGraph['db'];

function scalar(db: Db, sql: string): number {
  return db.prepare<[], { n: number }>(sql).get()?.n ?? 0;
}

/**
 * Starts a row-write counter on `db`'s connection. `total_changes()` is per
 * connection, so a daemon request that writes through the same handle mid-pass
 * counts too; that is still write volume the pass's database took.
 */
export function rowsWrittenCounter(db: Db): () => number {
  const before = scalar(db, 'SELECT total_changes() AS n');
  return () => scalar(db, 'SELECT total_changes() AS n') - before;
}

/** The database's size as this connection sees it, so pages still in the WAL count; the WAL's own overhead does not. */
export function dbBytes(db: Db): number {
  return scalar(
    db,
    'SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()',
  );
}

/** Each call returns the milliseconds since the previous one (or since creation). */
export function lapTimer(): () => number {
  let last = Date.now();
  return () => {
    const now = Date.now();
    const lap = now - last;
    last = now;
    return lap;
  };
}
