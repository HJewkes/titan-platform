import { KIT } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";
import { FIRST_COPY } from "./cost-report-queries.js";

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

function nullableNum(row: Row | undefined, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" ? value : null;
}

/** Main-thread context facts of one session; a sidechain's context is its subagent's window, not the session's. */
export interface SessionContextFacts {
  /** Largest main-thread context, or null when the session has no main-thread request. */
  peak: number | null;
  /** The session's earliest deliverable signal, with the context of its first main-thread request at or after it. */
  firstDeliverable: { ts: string; offset: number; context: number | null } | null;
}

/** The first deliverable is the first DONE report or `gh pr create` (TP-2150 §7). */
const FIRST_DELIVERABLE_SIGNALS = "('status_report', 'pr_create')";

const FIRST_DELIVERABLE_SQL = `WITH ranked AS (
    SELECT session_id, ts, byte_offset, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts, byte_offset) AS rn
    FROM session_signal WHERE ${IN_SESSIONS} AND signal IN ${FIRST_DELIVERABLE_SIGNALS})
  SELECT f.session_id AS sessionId, f.ts AS ts, f.byte_offset AS offset,
    (SELECT r.context_tokens FROM request r WHERE r.session_id = f.session_id AND r.is_sidechain = 0
       AND r.ts >= f.ts AND ${FIRST_COPY} ORDER BY r.ts LIMIT 1) AS context
  FROM ranked f WHERE rn = 1`;

/**
 * Reads `request` through `FIRST_COPY`, not the `request_cost` view: the view's windows cannot take
 * the session filter, so each read ranked every request in the graph (TP-2568).
 */
export function readSessionContextFacts(db: Db, sessionIds: readonly string[]): Map<string, SessionContextFacts> {
  const ids = JSON.stringify([...new Set(sessionIds)]);
  const facts = new Map<string, SessionContextFacts>();
  const factsOf = (sessionId: string) => facts.get(sessionId) ?? facts.set(sessionId, { peak: null, firstDeliverable: null }).get(sessionId)!;
  const peaks = db
    .prepare(
      `SELECT r.session_id AS sessionId, MAX(r.context_tokens) AS peak FROM request r
       WHERE r.${IN_SESSIONS} AND r.is_sidechain = 0 AND ${FIRST_COPY} GROUP BY r.session_id`,
    )
    .all({ ids });
  for (const row of asRows(peaks)) factsOf(text(row, "sessionId")).peak = nullableNum(row, "peak");
  for (const row of asRows(db.prepare(FIRST_DELIVERABLE_SQL).all({ ids }))) {
    factsOf(text(row, "sessionId")).firstDeliverable = { ts: text(row, "ts"), offset: num(row, "offset"), context: nullableNum(row, "context") };
  }
  return facts;
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
