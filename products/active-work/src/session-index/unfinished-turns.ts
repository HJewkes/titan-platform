import { rollupSessions } from '@titan-design/session-graph';
import type { WorkspaceGraph } from './graph.js';

const UNFINISHED_TURNS_PAGE = `
  SELECT rowid AS id, session_id, prompt_id FROM turn
  WHERE ended_at IS NULL AND rowid > ?
  ORDER BY rowid LIMIT ?`;

const FACT_OWNERS = `
  SELECT DISTINCT session_id FROM fact
  WHERE prompt_id IN (SELECT value FROM json_each(?))`;

/** One page's selection costs about a millisecond locally (TP-4200). */
export const UNFINISHED_PAGE_TURNS = 1_000;

interface UnfinishedTurn {
  id: number;
  session_id: string;
  prompt_id: string;
}

/**
 * Every session that still has a turn with no `ended_at`, read in keyset pages
 * of `pageTurns` turns with a yield after each. As one statement, the read
 * joined every unfinished turn to its facts and held the loop for seconds on a
 * loaded runner after the rollup itself was sliced (TP-4200). Both owners: a
 * turn's row keeps the lower session id on a prompt-id clash, while the rollup
 * aggregates by the session its facts carry. A throw at a yield point rolls up
 * nothing, which is safe: the turns stay unfinished for the next pass.
 */
export async function unfinishedSessionIds(
  graph: WorkspaceGraph,
  yieldPoint: () => Promise<void>,
  pageTurns: number = UNFINISHED_PAGE_TURNS,
): Promise<string[]> {
  const page = graph.db.prepare<[number, number], UnfinishedTurn>(UNFINISHED_TURNS_PAGE);
  const owners = graph.db.prepare<[string], { session_id: string }>(FACT_OWNERS);
  const sessions = new Set<string>();
  for (let after = 0; ; ) {
    const turns = page.all(after, pageTurns);
    const last = turns.at(-1);
    if (last === undefined) return [...sessions];
    for (const turn of turns) sessions.add(turn.session_id);
    const promptIds = JSON.stringify(turns.map((turn) => turn.prompt_id));
    for (const owner of owners.all(promptIds)) sessions.add(owner.session_id);
    after = last.id;
    await yieldPoint();
  }
}

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
  for (const [i, sessionId] of unique.entries()) {
    updated += rollupSessions(graph, [sessionId]);
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
  const sessionIds = await unfinishedSessionIds(graph, yieldPoint);
  return rollupYielding(graph, sessionIds, yieldPoint);
}
