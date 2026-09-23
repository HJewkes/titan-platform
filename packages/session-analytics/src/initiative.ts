/** Initiatives a session's task edges name, with how many edges name each. */
export interface TaskInitiative {
  initiative: string;
  edges: number;
}

/**
 * A task edge names the initiative outright, so it wins over the cwd guess. Among several,
 * the most-named initiative wins and a tie goes to the alphabetically first, for a stable report.
 */
export function sessionInitiative(tasks: readonly TaskInitiative[], cwd: string | null | undefined): string {
  const best = [...tasks].sort((a, b) => b.edges - a.edges || a.initiative.localeCompare(b.initiative))[0];
  return best ? best.initiative : initiativeFromCwd(cwd);
}

/** The cwd rule from `cf_analyze.py` `initiative()`. A worktree under a repo counts as that repo. */
export function initiativeFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return "unknown";
  const repo = /\/projects\/([^/]+)/.exec(cwd);
  if (repo) return `repo:${repo[1]}`;
  const activeWork = /active-work\/([^/]+)/.exec(cwd);
  if (activeWork) return `active-work:${activeWork[1]}`;
  if (/ac-fork-\w+/.test(cwd)) return "ac-fork(tmp)";
  const trimmed = cwd.replace(/\/+$/, "");
  return `other:${trimmed.slice(trimmed.lastIndexOf("/") + 1)}`;
}
