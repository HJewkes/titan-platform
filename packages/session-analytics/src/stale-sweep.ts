import type { Db } from "@titan-design/store-sqlite";
import { episodeEnds, lastMainRequests, staleRows, type LastMainRequest } from "./episodes.js";

const MAIN_THREAD_SESSIONS = "SELECT DISTINCT session_id AS sessionId FROM request WHERE is_sidechain = 0 ORDER BY session_id";

/**
 * `staleEpisodeSessions(db)` read `pageSize` sessions at a time, awaiting `yieldPoint` after each
 * page. The whole-graph call ranks every request in one statement and held a daemon's event loop
 * for most of a second (TP-4175). A scoped check agrees with the whole-graph one for the sessions it
 * names, so the pages, merged back into its order, give the same list.
 */
export async function staleEpisodeSessionsYielding(db: Db, yieldPoint: () => Promise<void>, pageSize = 20): Promise<string[]> {
  const ids = db.prepare<[], { sessionId: string }>(MAIN_THREAD_SESSIONS).all().map((row) => row.sessionId);
  const ends = episodeEnds(db);
  const stale: LastMainRequest[] = [];
  for (let i = 0; i < ids.length; i += pageSize) {
    stale.push(...staleRows(db, lastMainRequests(db, ids.slice(i, i + pageSize)), ends));
    await yieldPoint();
  }
  return stale.sort(newestRequestFirst).map((row) => row.sessionId);
}

/** The order `staleEpisodeSessions` sorts in SQL: SQLite's BINARY collation agrees with code-unit order on these ASCII keys. */
function newestRequestFirst(a: LastMainRequest, b: LastMainRequest): number {
  if (a.lastRequestAt !== b.lastRequestAt) return a.lastRequestAt > b.lastRequestAt ? -1 : 1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}
