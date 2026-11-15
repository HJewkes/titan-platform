import { KIT } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";
import { readSessionStats, type SessionStats } from "./task-actuals-queries.js";

export interface LedgerPr {
  prRef: string;
  state: string | null;
  mergedAt: string | null;
}

export interface LedgerVerdict {
  prRef: string;
  verdict: string;
  ts: string;
}

/** One session that worked a task, with what it cost and the PRs and review verdicts it left. */
export interface LedgerRow {
  sessionId: string;
  agentName: string | null;
  profile: string | null;
  /** First and last request time; null for a session with no request in the graph. */
  startedAt: string | null;
  endedAt: string | null;
  usd: number;
  /** True when any request used a model with no price row, so `usd` undercounts. */
  unpriced: boolean;
  prs: LedgerPr[];
  verdicts: LedgerVerdict[];
}

const SESSION_PREFIX = "session:";
const IDLE_CAP_MINUTES = 15;
const IDS = "(SELECT value FROM json_each(@ids))";

interface OriginRow {
  sessionId: string;
  agentName: string | null;
  profile: string | null;
}

/** Sessions whose spawn record names the task, or that have a live `ran` edge to it. */
function linkedSessionIds(db: Db, taskId: string): string[] {
  const named = db
    .prepare<[string], { sessionId: string }>(
      "SELECT session_id AS sessionId FROM session_origin WHERE task_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(task_ids) WHERE value = ?)",
    )
    .all(taskId);
  const ran = db
    .prepare<[string], { source: string }>(
      `SELECT source_ref AS source FROM "${KIT.edge}" WHERE relation = 'ran' AND t_expired IS NULL AND target_ref = ? AND source_ref LIKE '${SESSION_PREFIX}%'`,
    )
    .all(`task:${taskId}`);
  return [...new Set([...named.map((r) => r.sessionId), ...ran.map((r) => r.source.slice(SESSION_PREFIX.length))])];
}

function readOrigins(db: Db, ids: readonly string[]): Map<string, OriginRow> {
  const rows = db
    .prepare<[{ ids: string }], OriginRow>(`SELECT session_id AS sessionId, agent_name AS agentName, profile FROM session_origin WHERE session_id IN ${IDS}`)
    .all({ ids: JSON.stringify(ids) });
  return new Map(rows.map((r) => [r.sessionId, r]));
}

function readPrs(db: Db, ids: readonly string[]): Map<string, LedgerPr[]> {
  const rows = db
    .prepare<[{ ids: string }], LedgerPr & { source: string }>(
      `SELECT e.source_ref AS source, p.pr_ref AS prRef, p.state AS state, p.merged_at AS mergedAt
       FROM "${KIT.edge}" e JOIN pr p ON p.pr_ref = e.target_ref
       WHERE e.relation = 'linked' AND e.t_expired IS NULL AND e.source_ref IN ${IDS} ORDER BY p.pr_ref`,
    )
    .all({ ids: JSON.stringify(ids.map((id) => `${SESSION_PREFIX}${id}`)) });
  const bySession = new Map<string, LedgerPr[]>();
  for (const { source, ...pr } of rows) {
    const key = source.slice(SESSION_PREFIX.length);
    bySession.set(key, [...(bySession.get(key) ?? []), pr]);
  }
  return bySession;
}

function readVerdicts(db: Db, prRefs: readonly string[]): Map<string, LedgerVerdict[]> {
  const rows = db
    .prepare<[{ ids: string }], LedgerVerdict>(`SELECT pr_ref AS prRef, verdict, ts FROM pr_review WHERE pr_ref IN ${IDS} ORDER BY ts, source_key`)
    .all({ ids: JSON.stringify(prRefs) });
  const byPr = new Map<string, LedgerVerdict[]>();
  for (const row of rows) byPr.set(row.prRef, [...(byPr.get(row.prRef) ?? []), row]);
  return byPr;
}

function rowFor(id: string, origin: OriginRow | undefined, stats: SessionStats | undefined, prs: LedgerPr[], verdicts: Map<string, LedgerVerdict[]>): LedgerRow {
  return {
    sessionId: id,
    agentName: origin?.agentName ?? null,
    profile: origin?.profile ?? null,
    startedAt: stats?.firstTs ?? null,
    endedAt: stats?.lastTs ?? null,
    usd: stats?.usd ?? 0,
    unpriced: (stats?.unpriced ?? 0) > 0,
    prs,
    verdicts: prs.flatMap((pr) => verdicts.get(pr.prRef) ?? []),
  };
}

/** Newest start first; a session with no request sorts last, and ties break on the session id. */
function newestFirst(a: LedgerRow, b: LedgerRow): number {
  if (a.startedAt !== b.startedAt) {
    if (a.startedAt === null) return 1;
    if (b.startedAt === null) return -1;
    return a.startedAt < b.startedAt ? 1 : -1;
  }
  return a.sessionId.localeCompare(b.sessionId);
}

/** Every session linked to the task, open or done, with cost, PRs and review verdicts. */
export function taskLedger(db: Db, taskId: string): LedgerRow[] {
  const ids = linkedSessionIds(db, taskId);
  if (ids.length === 0) return [];
  const origins = readOrigins(db, ids);
  const stats = new Map(readSessionStats(db, ids, [IDLE_CAP_MINUTES]).map((s) => [s.sessionId, s]));
  const prs = readPrs(db, ids);
  const verdicts = readVerdicts(db, [...new Set([...prs.values()].flat().map((pr) => pr.prRef))]);
  return ids.map((id) => rowFor(id, origins.get(id), stats.get(id), prs.get(id) ?? [], verdicts)).sort(newestFirst);
}

/** The initiative the graph's task node names; null when the graph has no such task. */
export function readTaskInitiative(db: Db, taskId: string): string | null {
  const row = db.prepare<[string], { initiative: string | null }>("SELECT initiative FROM task WHERE task_id = ? AND initiative IS NOT NULL LIMIT 1").get(taskId);
  return row?.initiative ?? null;
}
