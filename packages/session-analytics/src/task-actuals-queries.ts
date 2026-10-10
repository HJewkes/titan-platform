import { KIT } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";

const IN_SESSIONS = "session_id IN (SELECT value FROM json_each(@ids))";

/** A spawn record that names tasks, with the profile and how the link was inferred. */
export interface OriginLink {
  sessionId: string;
  profile: string | null;
  taskIds: string[];
  taskSource: string | null;
}

interface OriginRow {
  sessionId: string;
  profile: string | null;
  taskIds: string;
  taskSource: string | null;
}

const ORIGIN_COLUMNS = "session_id AS sessionId, profile, task_ids AS taskIds, task_source AS taskSource";

function parseOrigin(row: OriginRow): OriginLink {
  const parsed: unknown = JSON.parse(row.taskIds);
  const taskIds = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  return { sessionId: row.sessionId, profile: row.profile, taskIds, taskSource: row.taskSource };
}

export function readTaskOrigins(db: Db): OriginLink[] {
  const rows = db.prepare(`SELECT ${ORIGIN_COLUMNS} FROM session_origin WHERE task_ids IS NOT NULL`).all() as OriginRow[];
  return rows.map(parseOrigin);
}

/** Origins for sessions found through a PR edge, whether or not they name a task. */
export function readOriginsOf(db: Db, sessionIds: readonly string[]): OriginLink[] {
  const rows = db
    .prepare(`SELECT session_id AS sessionId, profile, COALESCE(task_ids, '[]') AS taskIds, task_source AS taskSource FROM session_origin WHERE ${IN_SESSIONS}`)
    .all({ ids: JSON.stringify(sessionIds) }) as OriginRow[];
  return rows.map(parseOrigin);
}

export interface SessionStats {
  sessionId: string;
  requests: number;
  firstTs: string;
  lastTs: string;
  usd: number;
  unpriced: number;
  /** Request gaps, each capped at the given number of minutes, in milliseconds; a first request has no gap. */
  activeMs: number[];
}

/** One row per session, with the capped gap sum for every cap in `capsMinutes`, in order. */
export function readSessionStats(db: Db, sessionIds: readonly string[], capsMinutes: readonly number[]): SessionStats[] {
  const caps = capsMinutes.map((_, i) => `SUM(MIN(COALESCE(gap_ms, 0), @cap${i})) AS active${i}`).join(", ");
  const params: Record<string, unknown> = { ids: JSON.stringify(sessionIds) };
  capsMinutes.forEach((minutes, i) => (params[`cap${i}`] = minutes * 60_000));
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, COUNT(*) AS requests, MIN(ts) AS firstTs, MAX(ts) AS lastTs,
         SUM(cost_usd) AS usd, SUM(CASE WHEN priced THEN 0 ELSE 1 END) AS unpriced, ${caps}
       FROM request_cost WHERE ${IN_SESSIONS} GROUP BY session_id`,
    )
    .all(params) as Record<string, unknown>[];
  return rows.map((row) => ({
    sessionId: row.sessionId as string,
    requests: row.requests as number,
    firstTs: row.firstTs as string,
    lastTs: row.lastTs as string,
    usd: row.usd as number,
    unpriced: row.unpriced as number,
    activeMs: capsMinutes.map((_, i) => row[`active${i}`] as number),
  }));
}

/** Episodes an assignment opened, which is what the standing-peer overlay counts. */
export function readAssignmentCounts(db: Db, sessionIds: readonly string[]): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, COUNT(*) AS n FROM episode
       WHERE heuristic = 'worker-v1' AND opened_by IN ('brief', 'channel_followup') AND ${IN_SESSIONS} GROUP BY session_id`,
    )
    .all({ ids: JSON.stringify(sessionIds) }) as { sessionId: string; n: number }[];
  return new Map(rows.map((r) => [r.sessionId, r.n]));
}

export interface SessionPr {
  sessionId: string;
  prRef: string;
  mergedAt: string | null;
}

const SESSION_PREFIX = "session:";

/** Live session to PR `linked` edges for the given sessions. */
export function readSessionPrs(db: Db, sessionIds: readonly string[]): SessionPr[] {
  const refs = sessionIds.map((id) => `${SESSION_PREFIX}${id}`);
  const rows = db
    .prepare(
      `SELECT e.source_ref AS source, p.pr_ref AS prRef, p.merged_at AS mergedAt
       FROM "${KIT.edge}" e JOIN pr p ON p.pr_ref = e.target_ref
       WHERE e.relation = 'linked' AND e.t_expired IS NULL AND e.source_ref IN (SELECT value FROM json_each(@ids))`,
    )
    .all({ ids: JSON.stringify(refs) }) as { source: string; prRef: string; mergedAt: string | null }[];
  return rows.map((r) => ({ sessionId: r.source.slice(SESSION_PREFIX.length), prRef: r.prRef, mergedAt: r.mergedAt }));
}

/** Sessions linked to any of the given PRs. */
export function readPrSessions(db: Db, prRefs: readonly string[]): { prRef: string; sessionId: string }[] {
  const rows = db
    .prepare(
      `SELECT target_ref AS prRef, source_ref AS source FROM "${KIT.edge}"
       WHERE relation = 'linked' AND t_expired IS NULL AND source_ref LIKE '${SESSION_PREFIX}%' AND target_ref IN (SELECT value FROM json_each(@ids))`,
    )
    .all({ ids: JSON.stringify(prRefs) }) as { prRef: string; source: string }[];
  return rows.map((r) => ({ prRef: r.prRef, sessionId: r.source.slice(SESSION_PREFIX.length) }));
}
