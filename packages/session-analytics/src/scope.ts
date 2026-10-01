import type { Db } from "@titan-design/store-sqlite";
import { readAgentNames } from "./cost-report-queries.js";

/**
 * Narrows a report to some sessions. Every field left out matches all, and fields combine with AND.
 * Compactions and coverage stay window-wide: the graph does not key them to a request.
 */
export interface ReportScope {
  sessionIds?: readonly string[];
  /** Keeps sessions whose agent-chat agent name starts with it. */
  agentPrefix?: string;
  /** Report roles, as `byRole` names them. */
  roles?: readonly string[];
}

/** A predicate over a request's session and role; with no scope every request passes. */
export function scopeFilter(db: Db, scope: ReportScope = {}): (row: { sessionId: string; role: string }) => boolean {
  const ids = scope.sessionIds ? new Set(scope.sessionIds) : null;
  const named = scope.agentPrefix === undefined ? null : agentSessions(db, scope.agentPrefix);
  const roles = scope.roles ? new Set(scope.roles) : null;
  return (row) => (!ids || ids.has(row.sessionId)) && (!named || named.has(row.sessionId)) && (!roles || roles.has(row.role));
}

function agentSessions(db: Db, prefix: string): Set<string> {
  return new Set(readAgentNames(db).filter((row) => row.agentName.startsWith(prefix)).map((row) => row.sessionId));
}
