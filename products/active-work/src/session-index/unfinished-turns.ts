import { rollupSessions } from '@titan-design/session-graph';
import type { WorkspaceGraph } from './graph.js';

/**
 * Both owners: a turn's row keeps the lower session id on a prompt-id clash,
 * while the rollup aggregates by the session its facts carry.
 */
const UNFINISHED_SESSIONS = `
  SELECT session_id FROM turn WHERE ended_at IS NULL
  UNION
  SELECT session_id FROM fact
  WHERE prompt_id IN (SELECT prompt_id FROM turn WHERE ended_at IS NULL)`;

/**
 * Roll up `sessionIds` one session per transaction, yielding after each. One
 * transaction over a 500-session delta held the daemon's event loop for
 * seconds (TP-4172); the rollup recomputes rather than accumulates, so slicing
 * it changes no row. A throw at a yield point (a shutdown abort) rolls up the
 * rest before it propagates, as the scan does, so no continued turn is left
 * with stale aggregates.
 */
export async function rollupYielding(
  graph: WorkspaceGraph,
  sessionIds: readonly string[],
  yieldPoint: () => Promise<void>,
): Promise<number> {
  const unique = [...new Set(sessionIds)];
  let updated = 0;
  for (let i = 0; i < unique.length; i += 1) {
    updated += rollupSessions(graph, [unique[i]!]);
    try {
      await yieldPoint();
    } catch (err) {
      rollupSessions(graph, unique.slice(i + 1));
      throw err;
    }
  }
  return updated;
}

/**
 * Roll up every session that still has a turn with no `ended_at`.
 *
 * A pass advances each transcript's watermark as it indexes it and rolls up
 * only after the loop, so a pass killed or thrown in between leaves turns no
 * later pass would revisit (TP-875). The rollup sets `ended_at` on every turn
 * it reaches, so in steady state this finds nothing: one scan of the narrow
 * `turn` table, about 16k rows on the live graph as of 2026-10-03.
 */
export async function rollupUnfinishedTurns(
  graph: WorkspaceGraph,
  yieldPoint: () => Promise<void>,
): Promise<number> {
  const rows = graph.db.prepare<[], { session_id: string }>(UNFINISHED_SESSIONS).all();
  return rollupYielding(
    graph,
    rows.map((row) => row.session_id),
    yieldPoint,
  );
}
