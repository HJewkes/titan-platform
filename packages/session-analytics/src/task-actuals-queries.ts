import { KIT } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";

const IN_SESSIONS = "session_id IN (SELECT value FROM json_each(@ids))";

type Row = Record<string, unknown>;

function asRows(rows: unknown[]): Row[] {
  return rows.filter((row): row is Row => typeof row === "object" && row !== null);
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

/** SQLite hands back null for a SUM over no priced rows; that reads as zero. */
function num(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : 0;
}

/** A spawn record that names tasks, with the profile and how the link was inferred. */
export interface OriginLink {
  sessionId: string;
  profile: string | null;
  taskIds: string[];
  taskSource: string | null;
}

const ORIGIN_COLUMNS = "session_id AS sessionId, profile, task_ids AS taskIds, task_source AS taskSource";

function parseOrigin(row: Row): OriginLink {
  const parsed: unknown = JSON.parse(text(row, "taskIds"));
  const taskIds = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  return { sessionId: text(row, "sessionId"), profile: nullableText(row, "profile"), taskIds, taskSource: nullableText(row, "taskSource") };
}

export function readTaskOrigins(db: Db): OriginLink[] {
  const rows = db.prepare(`SELECT ${ORIGIN_COLUMNS} FROM session_origin WHERE task_ids IS NOT NULL`).all();
  return asRows(rows).map(parseOrigin);
}

/** Origins for sessions found through a PR edge, whether or not they name a task. */
export function readOriginsOf(db: Db, sessionIds: readonly string[]): OriginLink[] {
  const rows = db
    .prepare(`SELECT session_id AS sessionId, profile, COALESCE(task_ids, '[]') AS taskIds, task_source AS taskSource FROM session_origin WHERE ${IN_SESSIONS}`)
    .all({ ids: JSON.stringify(sessionIds) });
  return asRows(rows).map(parseOrigin);
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
    .all(params);
  return asRows(rows).map((row) => ({
    sessionId: text(row, "sessionId"),
    requests: num(row, "requests"),
    firstTs: text(row, "firstTs"),
    lastTs: text(row, "lastTs"),
    usd: num(row, "usd"),
    unpriced: num(row, "unpriced"),
    activeMs: capsMinutes.map((_, i) => num(row, `active${i}`)),
  }));
}

interface SessionPr {
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
    .all({ ids: JSON.stringify(refs) });
  return asRows(rows).map((r) => ({
    sessionId: text(r, "source").slice(SESSION_PREFIX.length),
    prRef: text(r, "prRef"),
    mergedAt: nullableText(r, "mergedAt"),
  }));
}

/** Sessions linked to any of the given PRs. */
export function readPrSessions(db: Db, prRefs: readonly string[]): { prRef: string; sessionId: string }[] {
  const rows = db
    .prepare(
      `SELECT target_ref AS prRef, source_ref AS source FROM "${KIT.edge}"
       WHERE relation = 'linked' AND t_expired IS NULL AND source_ref LIKE '${SESSION_PREFIX}%' AND target_ref IN (SELECT value FROM json_each(@ids))`,
    )
    .all({ ids: JSON.stringify(prRefs) });
  return asRows(rows).map((r) => ({ prRef: text(r, "prRef"), sessionId: text(r, "source").slice(SESSION_PREFIX.length) }));
}
