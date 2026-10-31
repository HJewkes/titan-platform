import { existsSync } from "node:fs";
import { runGit, type GitRunner } from "@titan-design/worktree";
import type { ParkTarget } from "./park-rules.js";

/** Uncommitted or unpushed work in the agent's tree, or in its branch when the tree is gone. */
export async function workBlocker(
  target: ParkTarget,
  git: GitRunner = runGit
): Promise<string | undefined> {
  if (existsSync(target.worktree))
    return (
      (await uncommitted(target.worktree, git)) ??
      (await unpushed(target.worktree, "HEAD", git))
    );
  if (!existsSync(target.gitRoot))
    return `neither ${target.worktree} nor ${target.gitRoot} is on disk`;
  const branch = await git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${target.branch}`],
    target.gitRoot
  );
  if (branch === null) return undefined;
  return unpushed(target.gitRoot, target.branch, git);
}

/** `-uall` so `status.showUntrackedFiles=no` cannot hide an untracked file. */
async function uncommitted(
  tree: string,
  git: GitRunner
): Promise<string | undefined> {
  const status = await git(["status", "--porcelain", "-uall"], tree);
  if (status === null) return `could not read git status in ${tree}`;
  return status === "" ? undefined : `uncommitted changes in ${tree}`;
}

async function unpushed(
  dir: string,
  ref: string,
  git: GitRunner
): Promise<string | undefined> {
  const base =
    (await upstreamOf(dir, ref, git)) ?? (await defaultBranch(dir, git));
  if (base === undefined)
    return `${ref} in ${dir} has no upstream and no default branch to compare with`;
  const ahead = await git(["rev-list", `${base.ref}..${ref}`], dir);
  if (ahead === null)
    return `could not compare ${ref} in ${dir} with ${base.ref}`;
  const count = ahead.split("\n").filter(Boolean).length;
  return count === 0
    ? undefined
    : `${count} commit(s) in ${dir} are not on ${base.label}`;
}

interface Base {
  ref: string;
  label: string;
}

/** The configured upstream, else `origin/<branch>`: a branch pushed without `-u` is still pushed. */
async function upstreamOf(
  dir: string,
  ref: string,
  git: GitRunner
): Promise<Base | undefined> {
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${ref}@{u}`],
    dir
  );
  if (upstream !== null)
    return { ref: upstream, label: `upstream ${upstream}` };
  const branch =
    ref === "HEAD"
      ? await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir)
      : ref;
  if (branch === null) return undefined;
  const remote = await git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    dir
  );
  return remote === null
    ? undefined
    : { ref: `origin/${branch}`, label: `origin/${branch}` };
}

async function defaultBranch(
  dir: string,
  git: GitRunner
): Promise<Base | undefined> {
  for (const candidate of ["origin/HEAD", "main", "master"]) {
    if (
      (await git(
        ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
        dir
      )) !== null
    )
      return {
        ref: candidate,
        label: `the default branch ${candidate} (no upstream)`,
      };
  }
  return undefined;
}
