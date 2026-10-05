import { gitOrNull } from "./git.js";

/** Ignored paths `git worktree remove` would delete that a build or re-attach puts back. */
const REGENERABLE_DIRS = ["node_modules", "dist", "coverage", ".turbo"];

/** `.claude` only at the top, since re-attach copies it from the repository root. */
const isRegenerable = (entry: string): boolean => {
  const segments = entry.split("/").filter(Boolean);
  return segments[0] === ".claude" || segments.some((segment) => REGENERABLE_DIRS.includes(segment));
};

/**
 * Why removing this worktree would lose files, or undefined when it would not.
 *
 * `-uall` so `status.showUntrackedFiles=no` cannot hide an untracked file the removal would take.
 * A status git cannot read counts as dirty: a broken gitdir says nothing about what is on disk.
 */
export async function unsavedWork(worktree: string): Promise<string | undefined> {
  const status = await gitOrNull(["status", "--porcelain", "-uall"], worktree);
  if (status === null) return `could not read git status in ${worktree}`;
  if (status !== "") return `uncommitted or untracked changes in ${worktree}`;
  const ignored = await gitOrNull(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], worktree);
  if (ignored === null) return `could not list ignored files in ${worktree}`;
  const kept = ignored.split("\n").filter((entry) => entry !== "" && !isRegenerable(entry));
  if (kept.length === 0) return undefined;
  return (
    `ignored files in ${worktree} would be deleted (${kept.slice(0, 3).join(", ")}); ` +
    `only ignored ${REGENERABLE_DIRS.join(", ")} and a top-level .claude are removed`
  );
}
