import type Database from 'better-sqlite3';
import type { WorkspaceGraph } from '../session-index/graph.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from './schema.js';

/**
 * Moving workspace spans out of `search_span` into `workspace_span` (TP-4680).
 *
 * There is no state to keep. Legacy rows at or above the base mean the graph is
 * not cut over; a source with legacy rows and none in the new table has not
 * been moved yet. A crash therefore leaves exactly the facts the next pass needs
 * to carry on, and nothing can fall out of step with the data.
 */

/** Span source ids that still hold legacy rows and have nothing in the new table. */
export function pendingBackfillSources(db: Database.Database): Set<number> {
  const rows = db
    .prepare<[number], { source_id: number }>(
      `SELECT DISTINCT l.source_id FROM search_span l
        WHERE l.source_id >= ?
          AND NOT EXISTS (SELECT 1 FROM workspace_span w WHERE w.source_id = l.source_id)`,
    )
    .all(WORKSPACE_SPAN_SOURCE_BASE);
  return new Set(rows.map((row) => row.source_id));
}

/**
 * Delete the legacy rows in one transaction, which is the flip: `workspaceSpanTable`
 * reads their absence, so readers change tables on this commit. Call it only
 * after a pass has written every file. Returns the rows retired.
 */
export function flipWorkspaceSpans(graph: WorkspaceGraph): number {
  return graph.db
    .prepare('DELETE FROM search_span WHERE source_id >= ?')
    .run(WORKSPACE_SPAN_SOURCE_BASE).changes;
}

export interface WorkspaceBackfillStatus {
  /** `complete` once no legacy span remains; a graph that never held one starts there. */
  state: 'pending' | 'in_progress' | 'complete';
  legacySpans: number;
  workspaceSpans: number;
  pendingFiles: number;
}

/**
 * Read-only, for `miner status`, which opens without migrating: a graph from
 * before schema 1003 has no new table yet, and that is a pending backfill.
 */
export function workspaceBackfillStatus(db: Database.Database): WorkspaceBackfillStatus {
  const count = (sql: string, ...params: number[]): number =>
    db.prepare<number[], { n: number }>(sql).get(...params)?.n ?? 0;
  const legacySpans = count(
    'SELECT COUNT(*) AS n FROM search_span WHERE source_id >= ?',
    WORKSPACE_SPAN_SOURCE_BASE,
  );
  const migrated = count(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'workspace_span'",
  );
  if (migrated === 0) {
    return { state: 'pending', legacySpans, workspaceSpans: 0, pendingFiles: 0 };
  }
  const workspaceSpans = count('SELECT COUNT(*) AS n FROM workspace_span');
  return {
    state: legacySpans === 0 ? 'complete' : workspaceSpans === 0 ? 'pending' : 'in_progress',
    legacySpans,
    workspaceSpans,
    pendingFiles: pendingBackfillSources(db).size,
  };
}
