import { taskActuals, type ScorecardActuals, type ScorecardPr } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { TaskFacts } from "./read-tasks.js";

/** Session-to-task links come from `session_origin`, whose ids a name and brief resolver inferred; F20 makes them recorded. */
const ORIGIN_LINK = "inferred:session-origin";
const WEAK_ORIGIN_LINK = "inferred:session-origin-weak";

export function prKey(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

const PrRecord = z.object({ repo: z.string(), number: z.number(), merged_at: z.string().nullable(), closed_at: z.string().nullable() });

/** Every PR the graph knows, keyed `owner/name#n` in lower case. */
export function readPrs(db: Db): Map<string, ScorecardPr> {
  const rows = db.prepare("SELECT repo, number, merged_at, closed_at FROM pr WHERE repo IS NOT NULL AND number IS NOT NULL").all();
  const prs = new Map<string, ScorecardPr>();
  for (const raw of rows) {
    const r = PrRecord.parse(raw);
    prs.set(prKey(r.repo, r.number), { repo: r.repo, pr: r.number, mergedAt: r.merged_at, closedAt: r.closed_at });
  }
  return prs;
}

/** PRs whose outcome the forge backfill checked, or that merged or closed, at or after `since`. */
export function readPrChanges(db: Db, since: string): { keys: Set<string>; mark: string } {
  const rows = db
    .prepare<[string, string, string], { repo: string; number: number; t: string }>(
      `SELECT repo, number, max(coalesce(outcome_checked_at, ''), coalesce(merged_at, ''), coalesce(closed_at, '')) AS t FROM pr
       WHERE repo IS NOT NULL AND number IS NOT NULL AND (outcome_checked_at >= ? OR merged_at >= ? OR closed_at >= ?)`,
    )
    .all(since, since, since);
  return { keys: new Set(rows.map((r) => prKey(r.repo, r.number))), mark: [since, ...rows.map((r) => r.t)].sort().at(-1)! };
}

/**
 * Bare task ids linked to sessions with requests at or after `since`, and the newest request time. The request table
 * has no rowid, so the mark is the request time; a request indexed late with an older time waits for `--rebuild`.
 * With no mark yet every task is dirty already, so the scan is skipped.
 */
export function readRequestChanges(db: Db, since: string | null): { taskIds: Set<string>; mark: string | null } {
  const mark = db.prepare<[], { m: string | null }>("SELECT max(ts) AS m FROM request").get()?.m ?? null;
  if (since === null || mark === null || mark < since) return { taskIds: new Set(), mark: mark ?? since };
  const rows = db
    .prepare<[string], { task_ids: string }>(
      `SELECT DISTINCT o.task_ids FROM session_origin o
       JOIN (SELECT DISTINCT session_id FROM request WHERE ts >= ?) r ON r.session_id = o.session_id WHERE o.task_ids IS NOT NULL`,
    )
    .all(since);
  return { taskIds: new Set(rows.flatMap((r) => taskIdsOf(r.task_ids))), mark };
}

function taskIdsOf(text: string): string[] {
  try {
    return z.array(z.string()).catch([]).parse(JSON.parse(text));
  } catch {
    return [];
  }
}

/** Cost per done task from `taskActuals`. A task no implementer session links to has no measured cost. */
export function readActuals(db: Db, tasks: readonly TaskFacts[], initiatives: readonly string[]): Map<string, ScorecardActuals> {
  const done = tasks.filter((t) => t.doneAt !== null).map((t) => ({ id: t.id, initiative: t.initiative, doneAt: t.doneAt }));
  if (done.length === 0) return new Map();
  const rows = taskActuals(db, done, { initiatives });
  const actuals = new Map<string, ScorecardActuals>();
  for (const row of rows) {
    if (row.flags.includes("no-impl-session")) continue;
    const link = row.flags.includes("weak-link") ? WEAK_ORIGIN_LINK : ORIGIN_LINK;
    actuals.set(`${row.initiative}/${row.taskId}`, { usd: row.usd, link });
  }
  return actuals;
}
