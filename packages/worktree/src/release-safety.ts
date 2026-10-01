import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { gitOrNull } from "./git.js";

const execFileAsync = promisify(execFile);

export interface ReleaseCheck {
  name: "dirty" | "pushed" | "landed" | "gh";
  ok: boolean;
  detail: string;
}

export interface WorktreeReleaseSafety {
  dirty: boolean;
  /** Commits that exist nowhere else: not on the remote, not in the base ref, and not landed. */
  unmerged: boolean;
  /** Every file the branch changed already matches the current base: a squash or rebase merge. */
  landed: boolean;
  /** Commits on the branch but not on `compareTo`; null when the range could not be counted. */
  ahead: number | null;
  checked: ReleaseCheck[];
}

/** The checkout's current branch, and the remote default if one is known locally. */
async function landingTargets(gitRoot: string): Promise<string[]> {
  const head = await gitOrNull(["symbolic-ref", "--quiet", "--short", "HEAD"], gitRoot);
  const remoteHead = await gitOrNull(["rev-parse", "--verify", "--quiet", "origin/HEAD"], gitRoot);
  return [head ?? "HEAD", ...(remoteHead === null ? [] : ["origin/HEAD"])];
}

/**
 * Has the branch's content reached `target`, whatever the commit ids say?
 *
 * A squash or rebase merge leaves the branch's own commits unreachable from the
 * base, so the commit count calls them unmerged. If every file the branch
 * changed since it forked is identical on `target`, nothing is lost by deleting
 * the branch. A later edit on `target` to one of those files makes this refuse,
 * which is the over-refusal we accept.
 */
async function hasLanded(gitRoot: string, branch: string, target: string): Promise<boolean> {
  if ((await gitOrNull(["diff", "--quiet", target, branch], gitRoot)) !== null) return true;
  const base = await gitOrNull(["merge-base", target, branch], gitRoot);
  if (base === null) return false;
  const files = await gitOrNull(["diff", "--no-renames", "--name-only", base, branch], gitRoot);
  if (files === null) return false;
  const touched = files.split("\n").filter(Boolean);
  if (touched.length === 0) return true;
  return (await gitOrNull(["diff", "--quiet", target, branch, "--", ...touched], gitRoot)) !== null;
}

async function landedOn(gitRoot: string, branch: string, targets: readonly string[]): Promise<string | null> {
  for (const target of targets) {
    if (await hasLanded(gitRoot, branch, target)) return target;
  }
  return null;
}

const GH_TIMEOUT_MS = 3_000;

/** Advisory only: never required, never allowed to change the git answer. */
async function ghPrState(gitRoot: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"], {
      cwd: gitRoot,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function dirtyCheck(dirty: boolean): ReleaseCheck {
  return { name: "dirty", ok: !dirty, detail: dirty ? "uncommitted changes in the worktree" : "worktree clean" };
}

function pushedCheck(ahead: number | null, compareTo: string): ReleaseCheck {
  if (ahead === null) return { name: "pushed", ok: false, detail: `could not count commits against ${compareTo}` };
  return { name: "pushed", ok: ahead === 0, detail: `${ahead} commit(s) not on ${compareTo}` };
}

function landedCheck(target: string | null, targets: readonly string[]): ReleaseCheck {
  return target === null
    ? { name: "landed", ok: false, detail: `work not landed on ${targets.join(" or ")}` }
    : { name: "landed", ok: true, detail: `work landed on ${target}` };
}

/** Commits on `branch` that are on neither its remote copy nor `baseRef`; null when uncountable. */
async function commitsAhead(gitRoot: string, branch: string, baseRef: string): Promise<[number | null, string]> {
  const remote = await gitOrNull(["rev-parse", "--verify", `origin/${branch}`], gitRoot);
  const compareTo = remote === null ? baseRef : `origin/${branch}`;
  const count = await gitOrNull(["rev-list", "--count", `${compareTo}..${branch}`], gitRoot);
  return [count === null ? null : Number.parseInt(count, 10), compareTo];
}

/**
 * Is it safe to destroy this worktree and its branch?
 *
 * With no remote the comparison falls back to the commit the branch forked
 * from, since treating "no remote" as safe would silently delete every commit
 * the agent made. Over-refusal is the failure mode we accept: `force` is one
 * flag away.
 *
 * Commits that fail that count are still safe when their content has landed on
 * the checkout's current branch (or `origin/HEAD`), which is how a squash-merged
 * PR looks once the host deletes the remote branch. Nothing is fetched: a stale
 * local main makes this refuse until someone pulls.
 */
export async function inspectForRelease(
  gitRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string
): Promise<WorktreeReleaseSafety> {
  const status = existsSync(worktreePath) ? await gitOrNull(["status", "--porcelain"], worktreePath) : null;
  const dirty = (status ?? "").length > 0;
  const checked = [dirtyCheck(dirty)];

  if ((await gitOrNull(["rev-parse", "--verify", branch], gitRoot)) === null)
    return { dirty, unmerged: false, landed: false, ahead: 0, checked };

  const [ahead, compareTo] = await commitsAhead(gitRoot, branch, baseRef);
  checked.push(pushedCheck(ahead, compareTo));
  if (ahead === 0) return { dirty, unmerged: false, landed: false, ahead, checked };

  const targets = await landingTargets(gitRoot);
  const target = await landedOn(gitRoot, branch, targets);
  checked.push(landedCheck(target, targets));
  if (target === null) {
    const state = await ghPrState(gitRoot, branch);
    if (state !== null) checked.push({ name: "gh", ok: true, detail: `gh reports the PR as ${state}` });
  }
  return { dirty, unmerged: target === null, landed: target !== null, ahead, checked };
}

/** The failed checks, as one line a coordinator can act on. */
export function describeRefusal(safety: WorktreeReleaseSafety): string {
  const failed = safety.checked.filter((c) => !c.ok && !(c.name === "pushed" && safety.landed));
  const advisory = safety.checked.filter((c) => c.name === "gh").map((c) => c.detail);
  return [...failed.map((c) => c.detail), ...advisory].join("; ");
}
