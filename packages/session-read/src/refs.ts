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
 * Matches the worktree package's `DEFAULT_BASE_PATH` (`.worktrees`). Inlined
 * rather than imported so session-read does not pull in the git tooling for one
 * string; a worktree under a custom base path is not recognised.
 */
const LEAKED_WORKTREE_PREFIX = /^\.worktrees\/[^/]+\/(.+)$/;

/**
 * A worktree's own `.git` file makes it the root while it exists. Once it is
 * removed, the walk reaches the main checkout and the path keeps
 * `.worktrees/<name>/`, so the same file would get one ref per worktree.
 */
const stripWorktreePrefix = (repoPath: string): string => LEAKED_WORKTREE_PREFIX.exec(repoPath)?.[1] ?? repoPath;

/**
 * Resolve a touched file to `(repo, repo-relative path)` by its nearest `.git`
 * ancestor, so paths line up with `git ls-files` whatever directory the tool
 * call ran in. A file outside any working tree keeps its absolute form with a
 * null repo: unattributed, not mis-attributed. A path under a removed
 * `.worktrees/<name>/` resolves as if that worktree still existed.
 */
export function toRepoRelative(filePath: string): RepoRelativePath {
  if (!path.isAbsolute(filePath)) return { repo: null, path: filePath };
  const repo = resolveRepo(path.dirname(filePath));
  if (!repo) return { repo: null, path: filePath };
  const relative = path.relative(repo.root, filePath).split(path.sep).join("/");
  return { repo: repo.name, path: stripWorktreePrefix(relative) };
}

/**
 * The inverse of `fileRef`: `file:<repo>/<path>` to `(repo, path)`, or null for
 * a ref that is not a file ref. A ref stored with a null repo (an absolute path,
 * or a bare relative one) comes back with a null repo, so callers render it as
 * plain text. A leaked `.worktrees/<name>/` prefix from an older ingest is
 * stripped, so the path is the code-graph file id.
 */
export function parseFileRef(ref: string): RepoRelativePath | null {
  if (!ref.startsWith("file:")) return null;
  const rest = ref.slice("file:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return { repo: null, path: rest };
  return { repo: rest.slice(0, slash), path: stripWorktreePrefix(rest.slice(slash + 1)) };
}

/** The repo a tool call ran in, for signals keyed by `cwd` (branches, PRs). */
export function repoForCwd(cwd: string | null): string | null {
  return resolveRepo(cwd)?.name ?? null;
}
