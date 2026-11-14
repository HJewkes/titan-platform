import { RELATIONS, sessionRef, taskRef } from "@titan-design/session-read";
import { readTaskInitiatives, type SessionTaskInitiative } from "./files-touched.js";
import type { SessionGraph } from "./graph.js";
import { KIT } from "./schema.js";

/** What one commit says about where it came from, as its caller read the message. */
export interface CommitLinks {
  /** The `(#n)` a squash subject ends with, or null. */
  prNumber: number | null;
  /** Short repo name of the blamed checkout; narrows a PR number shared across repos. */
  repoName: string | null;
  /** `Agent-Session:` trailer values. */
  trailerSessionIds: readonly string[];
  /** Task ids the squash message's `Refs:` line names. */
  refTaskIds: readonly string[];
}

/** The rung that found a session: its own trailer, a link to the subject's PR, or a run of that PR's task. */
export type SessionStep = "trailer" | "pr-subject" | "pr-task";
/** The rung that found a task: the squash `Refs:` line, or a session found above that ran it. */
export type TaskStep = "refs" | "session-ran";

export interface LineageTask {
  taskId: string;
  initiative: string | null;
  step: TaskStep;
}

export interface LineageSession {
  sessionId: string;
  step: SessionStep;
  cwd: string | null;
  title: string | null;
  /** Initiatives the session's task edges name, so the caller can decide who may see it. */
  tasks: SessionTaskInitiative[];
}

export interface CommitLineage {
  prRefs: string[];
  tasks: LineageTask[];
  sessions: LineageSession[];
}

const SESSION_PREFIX = "session:";
const TASK_PREFIX = "task:";

/** Compares a bare repo name with the last path segment of an `owner/name` repo. */
function sameRepoName(repo: string, name: string): boolean {
  return repo.split("/").pop()!.toLowerCase() === name.toLowerCase();
}

function prRefsFor(graph: SessionGraph, links: CommitLinks): string[] {
  if (links.prNumber === null) return [];
  const rows = graph.db.prepare<[number], { pr_ref: string; repo: string | null }>("SELECT pr_ref, repo FROM pr WHERE number = ?").all(links.prNumber);
  const name = links.repoName;
  return rows.filter((row) => name === null || (row.repo !== null && sameRepoName(row.repo, name))).map((row) => row.pr_ref).sort();
}

/** Sessions with a live `relation` edge to any of the targets. */
function sessionsWith(graph: SessionGraph, relation: string, targetRefs: readonly string[]): string[] {
  const sql = `SELECT DISTINCT substr(source_ref, ${SESSION_PREFIX.length + 1}) AS id FROM "${KIT.edge}"
    WHERE relation = @relation AND t_expired IS NULL AND source_ref LIKE '${SESSION_PREFIX}%'
      AND target_ref IN (SELECT value FROM json_each(@refs)) ORDER BY id`;
  return graph.db.prepare<[object], { id: string }>(sql).all({ relation, refs: JSON.stringify(targetRefs) }).map((r) => r.id);
}

function tasksRanBy(graph: SessionGraph, sessionIds: readonly string[]): string[] {
  const sql = `SELECT DISTINCT substr(target_ref, ${TASK_PREFIX.length + 1}) AS id FROM "${KIT.edge}"
    WHERE relation = @relation AND t_expired IS NULL AND target_ref LIKE '${TASK_PREFIX}%'
      AND source_ref IN (SELECT value FROM json_each(@refs)) ORDER BY id`;
  return graph.db.prepare<[object], { id: string }>(sql).all({ relation: RELATIONS.RAN, refs: JSON.stringify(sessionIds.map(sessionRef)) }).map((r) => r.id);
}

function taskInitiative(graph: SessionGraph, taskId: string): string | null {
  return graph.db.prepare<[string], { initiative: string | null }>("SELECT initiative FROM task WHERE task_ref = ?").get(taskRef(taskId))?.initiative ?? null;
}

/** First rung wins: an id already found higher up the ladder keeps that step. */
function addSteps<S>(found: Map<string, S>, ids: readonly string[], step: S): void {
  for (const id of ids) if (!found.has(id)) found.set(id, step);
}

function describeSessions(graph: SessionGraph, steps: ReadonlyMap<string, SessionStep>): LineageSession[] {
  const ids = [...steps.keys()];
  const tasks = readTaskInitiatives(graph, ids);
  const select = graph.db.prepare<[string], { cwd: string | null; title: string | null }>("SELECT cwd, ai_title AS title FROM session WHERE session_id = ?");
  return ids.map((sessionId) => {
    const row = select.get(sessionId);
    return { sessionId, step: steps.get(sessionId)!, cwd: row?.cwd ?? null, title: row?.title ?? null, tasks: tasks.get(sessionId) ?? [] };
  });
}

/**
 * Walks one commit up the ladder: its `Agent-Session:` trailer, then the sessions linked to the
 * PR its subject names, then the tasks those sessions ran or the `Refs:` line names, then every
 * session that ran one of those tasks. Each row says which rung found it. Which rows a caller may
 * see is the caller's policy: sessions carry the cwd and task initiatives it decides on.
 */
export function commitLineage(graph: SessionGraph, links: CommitLinks): CommitLineage {
  const prRefs = prRefsFor(graph, links);
  const sessionSteps = new Map<string, SessionStep>();
  addSteps(sessionSteps, links.trailerSessionIds, "trailer");
  addSteps(sessionSteps, sessionsWith(graph, RELATIONS.LINKED, prRefs), "pr-subject");
  const taskSteps = new Map<string, TaskStep>();
  addSteps(taskSteps, links.refTaskIds, "refs");
  addSteps(taskSteps, tasksRanBy(graph, [...sessionSteps.keys()]), "session-ran");
  addSteps(sessionSteps, sessionsWith(graph, RELATIONS.RAN, [...taskSteps.keys()].map(taskRef)), "pr-task");
  const tasks = [...taskSteps].map(([taskId, step]) => ({ taskId, initiative: taskInitiative(graph, taskId), step }));
  return { prRefs, tasks, sessions: describeSessions(graph, sessionSteps) };
}
