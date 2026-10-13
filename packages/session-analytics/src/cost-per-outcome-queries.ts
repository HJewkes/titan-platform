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
  for (const row of db.prepare(TASK_SESSIONS).all({ tasks: JSON.stringify(tasks) }).filter(isTaskSession)) {
    sessions.set(row.taskId, [...(sessions.get(row.taskId) ?? []), row.sessionId]);
  }
  return sessions;
}

function isTaskSession(row: unknown): row is { taskId: string; sessionId: string } {
  if (typeof row !== "object" || row === null) return false;
  return "taskId" in row && typeof row.taskId === "string" && "sessionId" in row && typeof row.sessionId === "string";
}

export interface SessionSpend {
  costUsd: number;
  requests: number;
}

/** List-price spend and request count per session over requests in the window. */
export function readSessionSpend(db: Db, window: ReportWindow): Map<string, SessionSpend> {
  const spend = new Map<string, SessionSpend>();
  for (const row of readCostRows(db, window)) {
    const session = spend.get(row.sessionId) ?? { costUsd: 0, requests: 0 };
    spend.set(row.sessionId, { costUsd: session.costUsd + row.costUsd, requests: session.requests + 1 });
  }
  return spend;
}
