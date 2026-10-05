import { gitOrNull, gitText as git } from "./git.js";
import type { WorktreeRecord } from "./reattach.js";
import { unsavedWork } from "./unsaved-work.js";

/**
 * Park a finished agent's worktree: the tree is removed and the branch kept, so
 * `recreateWorktree` puts it back at the same path. Parking never deletes a
 * branch: in a repo with no remote the local branch is the only copy of the work.
 */

/** With an origin, the branch must be on it with nothing ahead; without one, the kept local branch is the copy. */
async function unpushed(target: WorktreeRecord): Promise<string | undefined> {
  const { worktree, branch } = target;
  if ((await gitOrNull(["remote", "get-url", "origin"], worktree)) === null) return undefined;
  if ((await gitOrNull(["rev-parse", "--verify", "--quiet", `origin/${branch}`], worktree)) === null)
    return `${branch} is not on origin; push it first`;
  const ahead = await gitOrNull(["rev-list", `origin/${branch}..HEAD`], worktree);
  if (ahead === null) return `could not compare ${worktree} with origin/${branch}`;
  const count = ahead.split("\n").filter(Boolean).length;
  return count === 0 ? undefined : `${count} commit(s) in ${worktree} are not on origin/${branch}; push first`;
}

/** A commit on a detached HEAD or another branch would be unreachable once the tree is gone, since only `branch` is kept. */
async function offBranch(target: WorktreeRecord): Promise<string | undefined> {
  const head = await gitOrNull(["symbolic-ref", "--quiet", "--short", "HEAD"], target.worktree);
  if (head === target.branch) return undefined;
  const where = head === null ? "detached" : `on ${head}`;
  return `HEAD in ${target.worktree} is ${where}, not on ${target.branch}; check out ${target.branch} first`;
}

/**
 * Refuse a tree that would lose anything; otherwise remove it without --force and keep the branch.
 * `recheck` runs after the git checks and right before the removal, so a spawn or resume that
 * started meanwhile is caught. Returns the parked head.
 */
export async function parkWorktree(
  target: WorktreeRecord,
  recheck: () => string | undefined = () => undefined
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const refusal = (await offBranch(target)) ?? (await unsavedWork(target.worktree)) ?? (await unpushed(target));
  if (refusal) return { ok: false, reason: refusal };
  const head = await git(["rev-parse", "HEAD"], target.worktree);
  const late = recheck();
  if (late) return { ok: false, reason: late };
  try {
    await git(["worktree", "remove", target.worktree], target.gitRoot);
  } catch (err) {
    const detail = String((err as { stderr?: unknown }).stderr || (err as Error).message).trim();
    return { ok: false, reason: `git would not remove ${target.worktree}: ${detail.split("\n")[0]}` };
  }
  return { ok: true, head };
}
