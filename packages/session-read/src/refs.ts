import path from "node:path";
import { resolveRepo } from "./repo-root.js";

/**
 * Relation vocabulary for the edges a transcript yields. Documented, not
 * enforced by a CHECK constraint: a new relation is an INSERT, never a migration.
 * Direction is fixed per name; reverse edges are never written.
 */
export const RELATIONS = {
  /** session --touched--> file: any Read/Write/Edit/MultiEdit on that path. */
  TOUCHED: "touched",
  /** session --linked--> pr: a `pr-link` event naming that PR. */
  LINKED: "linked",
  /** session --worked--> branch: a git/gh command naming that branch. */
  WORKED: "worked",
  /** session --ran--> task: an `active-work`/`aw` command naming that task id. */
  RAN: "ran",
  /** session --spawned--> agent (the dispatch) or --spawned--> session (from the child's own sidechain). */
  SPAWNED: "spawned",
  /** agent --transcribed_in--> session: the child transcript a dispatch produced. */
  TRANSCRIBED_IN: "transcribed_in",
  /** session --produced--> artifact: an `Artifact` tool_use or `frame-link`. */
  PRODUCED: "produced",
  /** session --edited_by_human--> file: an `edited_text_file` attachment. */
  EDITED_BY_HUMAN: "edited_by_human",
} as const;

export type Relation = (typeof RELATIONS)[keyof typeof RELATIONS];

/** Refs derive from transcript content alone, never from a database id, so they are stable across rebuilds. */
export const sessionRef = (sessionId: string): string => `session:${sessionId}`;
export const fileRef = (repo: string | null, filePath: string): string => (repo ? `file:${repo}/${filePath}` : `file:${filePath}`);
export const prRef = (repo: string, prNumber: number): string => `pr:${repo}#${prNumber}`;
export const branchRef = (repo: string | null, name: string): string => (repo ? `branch:${repo}/${name}` : `branch:${name}`);
export const taskRef = (taskId: string): string => `task:${taskId}`;
export const agentRef = (toolUseId: string): string => `agent:${toolUseId}`;
export const artifactRef = (id: string): string => `artifact:${id}`;

export interface RepoRelativePath {
  repo: string | null;
  path: string;
}

/**
 * Resolve a touched file to `(repo, repo-relative path)` by its nearest `.git`
 * ancestor, so paths line up with `git ls-files` whatever directory the tool
 * call ran in. A file outside any working tree keeps its absolute form with a
 * null repo: unattributed, not mis-attributed.
 */
export function toRepoRelative(filePath: string): RepoRelativePath {
  if (!path.isAbsolute(filePath)) return { repo: null, path: filePath };
  const repo = resolveRepo(path.dirname(filePath));
  if (!repo) return { repo: null, path: filePath };
  return { repo: repo.name, path: path.relative(repo.root, filePath) };
}

/** The repo a tool call ran in, for signals keyed by `cwd` (branches, PRs). */
export function repoForCwd(cwd: string | null): string | null {
  return resolveRepo(cwd)?.name ?? null;
}
