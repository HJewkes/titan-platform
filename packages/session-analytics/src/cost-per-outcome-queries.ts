import type { Db } from "@titan-design/store-sqlite";
import { readAgentNames, readCostRows, type ReportWindow } from "./cost-report-queries.js";

/** Each agent-chat name to the sessions that ran under it. */
export function readSessionsByName(db: Db): Map<string, string[]> {
  const sessions = new Map<string, string[]>();
  for (const row of readAgentNames(db)) sessions.set(row.agentName, [...(sessions.get(row.agentName) ?? []), row.sessionId]);
  return sessions;
}

const TASK_SESSIONS = `
  SELECT DISTINCT t.value AS taskId, o.session_id AS sessionId
  FROM session_origin o, json_each(o.task_ids) t
  WHERE o.task_ids IS NOT NULL AND json_valid(o.task_ids) AND t.value IN (SELECT value FROM json_each(@tasks))
  ORDER BY o.session_id`;

/** Each of `tasks` to the sessions whose spawn record names it in `task_ids`. */
export function readSessionsByTask(db: Db, tasks: readonly string[]): Map<string, string[]> {
  const sessions = new Map<string, string[]>();
  for (const row of db.prepare(TASK_SESSIONS).all({ tasks: JSON.stringify(tasks) }) as { taskId: string; sessionId: string }[]) {
    sessions.set(row.taskId, [...(sessions.get(row.taskId) ?? []), row.sessionId]);
  }
  return sessions;
}

/** List-price spend per session over requests in the window. */
export function readSessionCosts(db: Db, window: ReportWindow): Map<string, number> {
  const costs = new Map<string, number>();
  for (const row of readCostRows(db, window)) costs.set(row.sessionId, (costs.get(row.sessionId) ?? 0) + row.costUsd);
  return costs;
}
