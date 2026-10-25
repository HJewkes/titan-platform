/** Offset advance per transcript row; a row whose offset fell was re-read from byte 0. */
export function bytesAdvanced(before: Map<number, number>, after: Map<number, number>): number {
  let total = 0;
  for (const [sourceId, offset] of after) {
    const was = before.get(sourceId) ?? 0;
    total += offset >= was ? offset - was : offset;
  }
  return total;
}

interface PragmaDb {
  pragma(source: string, options: { simple: true }): unknown;
  prepare(source: string): { get(): unknown };
}

/**
 * Starts a row-write counter on `db`'s connection. `total_changes()` is per
 * connection, so a daemon request that writes through the same handle mid-pass
 * counts too; that is still write volume the pass's database took.
 */
export function rowsWrittenCounter(db: PragmaDb): () => number {
  const totalChanges = (): number =>
    (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const before = totalChanges();
  return () => totalChanges() - before;
}

/** The database file's size in pages, not counting the WAL. */
export function dbBytes(db: PragmaDb): number {
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return pageCount * pageSize;
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
