import { EPISODE_TABLE } from "./audit-schema-v5.js";
import type { SessionGraph } from "./graph.js";

/**
 * One stretch of a session as some segmentation heuristic cut it. The rule
 * lives above storage (session-analytics); this package only keeps its output.
 * Offsets are byte offsets into the session's transcript.
 */
export interface EpisodeRow {
  episodeIndex: number;
  heuristicVersion: number;
  startedAt: string;
  endedAt: string;
  startOffset: number;
  endOffset: number;
  /** `session_start`, `brief`, `channel_followup`, `idle_gap`, `pr_merge`, `spawn_wave_complete`, `task_wrap`, `context_reset`, or a newer heuristic's term. */
  openedBy: string;
  assignmentOffset?: number | null;
  firstDeliverableOffset?: number | null;
  firstDeliverableSignal?: string | null;
  firstStatusOffset?: number | null;
}

const DELETE_EPISODES = `DELETE FROM ${EPISODE_TABLE} WHERE session_id = ? AND heuristic = ?`;

const INSERT_EPISODE = `
  INSERT INTO ${EPISODE_TABLE} (session_id, episode_index, heuristic, heuristic_version, started_at, ended_at,
    start_offset, end_offset, opened_by, assignment_offset, first_deliverable_offset, first_deliverable_signal, first_status_offset)
  VALUES (@sessionId, @episodeIndex, @heuristic, @heuristicVersion, @startedAt, @endedAt,
    @startOffset, @endOffset, @openedBy, @assignmentOffset, @firstDeliverableOffset, @firstDeliverableSignal, @firstStatusOffset)`;

/**
 * The only writer of `episode`. Replaces one heuristic's segmentation of one
 * session atomically and leaves every other heuristic's rows alone, so two rule
 * sets can coexist while one is compared against the other. Returns rows written.
 */
export function replaceEpisodes(graph: SessionGraph, sessionId: string, heuristic: string, rows: readonly EpisodeRow[]): number {
  const remove = graph.db.prepare(DELETE_EPISODES);
  const insert = graph.db.prepare(INSERT_EPISODE);
  return graph.db.transaction(() => {
    remove.run(sessionId, heuristic);
    for (const row of rows) insert.run(episodeParams(sessionId, heuristic, row));
    return rows.length;
  })();
}

function episodeParams(sessionId: string, heuristic: string, row: EpisodeRow): Record<string, string | number | null> {
  return {
    sessionId, heuristic,
    episodeIndex: row.episodeIndex, heuristicVersion: row.heuristicVersion,
    startedAt: row.startedAt, endedAt: row.endedAt, startOffset: row.startOffset, endOffset: row.endOffset, openedBy: row.openedBy,
    assignmentOffset: row.assignmentOffset ?? null, firstDeliverableOffset: row.firstDeliverableOffset ?? null,
    firstDeliverableSignal: row.firstDeliverableSignal ?? null, firstStatusOffset: row.firstStatusOffset ?? null,
  };
}
