import { rollupYielding } from '@titan-design/session-graph';
import type { WorkspaceGraph } from './graph.js';

const UNFINISHED_PAGE = 2_000;

const UNFINISHED_TURNS = `
  SELECT rowid, session_id, prompt_id FROM turn
  WHERE ended_at IS NULL AND rowid > ? ORDER BY rowid LIMIT ?`;

/**
 * Both owners: a turn's row keeps the lower session id on a prompt-id clash,
 * while the rollup aggregates by the session its facts carry.
 */
const FACT_OWNERS = `
  SELECT DISTINCT session_id FROM fact WHERE prompt_id IN (SELECT value FROM json_each(?))`;

interface UnfinishedTurn {
  rowid: number;
  session_id: string;
  prompt_id: string;
}

/**
 * Every session owning an unfinished turn, read a page at a time with a yield
 * after each. As one query over 125k unfinished turns it held the loop for
 * about 120 ms locally and past a second on a loaded CI runner (TP-4200).
 */
async function unfinishedSessions(
  graph: WorkspaceGraph,
  yieldPoint: () => Promise<void>,
  pageSize: number,
): Promise<Set<string>> {
  const turns = graph.db.prepare<[number, number], UnfinishedTurn>(UNFINISHED_TURNS);
  const owners = graph.db.prepare<[string], { session_id: string }>(FACT_OWNERS);
  const sessions = new Set<string>();
  let cursor = 0;
  for (;;) {
    const page = turns.all(cursor, pageSize);
    if (page.length === 0) return sessions;
    for (const turn of page) sessions.add(turn.session_id);
    const promptIds = JSON.stringify(page.map((turn) => turn.prompt_id));
    for (const row of owners.all(promptIds)) sessions.add(row.session_id);
    cursor = page[page.length - 1].rowid;
    await yieldPoint();
  }
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
  pageSize = UNFINISHED_PAGE,
): Promise<number> {
  const sessions = await unfinishedSessions(graph, yieldPoint, pageSize);
  return rollupYielding(graph, [...sessions], yieldPoint);
}
