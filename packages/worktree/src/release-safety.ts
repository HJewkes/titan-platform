import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { gitOrNull } from "./git.js";
import { readMergedTipProof } from "./gh-landing.js";
import { DEFAULT_GH_TIMEOUT_MS, type ReleaseProof } from "./options.js";
import { observeUnsavedWork, type IgnoredFilesPolicy, type UnsavedObservation } from "./unsaved-work.js";

const execFileAsync = promisify(execFile);

interface ProofPolicy { mode: ReleaseProof; ghTimeoutMs: number; ignoredFiles?: IgnoredFilesPolicy }

export type { IgnoredFilesPolicy };

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

/** Advisory only: never required, never allowed to change the git answer. */
async function ghPrState(gitRoot: string, branch: string, timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"], {
      cwd: gitRoot,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function dirtyCheck(unsaved: string | undefined): ReleaseCheck {
  return { name: "dirty", ok: unsaved === undefined, detail: unsaved ?? "worktree clean" };
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

/** Shared implementation for public inspection and allocator presentation. */
async function inspectReleaseSafety(
  gitRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
  proof: ProofPolicy,
  observations: UnsavedObservation[]
): Promise<WorktreeReleaseSafety> {
  const unsaved = await recordUnsaved(worktreePath, observations, proof.ignoredFiles);
  const dirty = unsaved !== undefined;
  const checked = [dirtyCheck(unsaved)];

  if ((await gitOrNull(["rev-parse", "--verify", branch], gitRoot)) === null)
    return { dirty, unmerged: false, landed: false, ahead: 0, checked };

  const [ahead, compareTo] = await commitsAhead(gitRoot, branch, baseRef);
  checked.push(pushedCheck(ahead, compareTo));
  if (ahead === 0) return { dirty, unmerged: false, landed: false, ahead, checked };

  const targets = await landingTargets(gitRoot);
  const target = await landedOn(gitRoot, branch, targets);
  checked.push(landedCheck(target, targets));
  const safety = { dirty, unmerged: target === null, landed: target !== null, ahead, checked };
  return target === null
    ? withExternalLanding(safety, { gitRoot, worktreePath, branch }, proof, observations)
    : safety;
}

/** The external proof may outlive the first file check; retain earlier refusals too. */
async function withPostProofFileSafety(
  safety: WorktreeReleaseSafety,
  worktreePath: string,
  observations: UnsavedObservation[],
  ignoredFiles: IgnoredFilesPolicy | undefined
): Promise<WorktreeReleaseSafety> {
  const afterProof = safety.landed ? await recordUnsaved(worktreePath, observations, ignoredFiles) : undefined;
  if (afterProof !== undefined) safety.checked.push(dirtyCheck(afterProof));
  return { ...safety, dirty: safety.dirty || afterProof !== undefined };
}

async function recordUnsaved(
  worktree: string,
  observations: UnsavedObservation[],
  ignoredFiles: IgnoredFilesPolicy | undefined
): Promise<string | undefined> {
  const observation = existsSync(worktree) ? await observeUnsavedWork(worktree, ignoredFiles) : undefined;
  if (observation !== undefined) observations.push(observation);
  return observation?.detail;
}

async function withExternalLanding(
  safety: WorktreeReleaseSafety,
  ref: { gitRoot: string; worktreePath: string; branch: string },
  policy: ProofPolicy,
  observations: UnsavedObservation[]
): Promise<WorktreeReleaseSafety> {
  if (policy.mode === "git-or-merged-pr-tip") {
    const proof = await readMergedTipProof(ref.gitRoot, ref.branch, policy.ghTimeoutMs);
    if (proof !== null) {
      safety.checked.push(proof.check);
      return withPostProofFileSafety({ ...safety, unmerged: !proof.merged, landed: proof.merged }, ref.worktreePath, observations, policy.ignoredFiles);
    }
  } else {
    const state = await ghPrState(ref.gitRoot, ref.branch, policy.ghTimeoutMs);
    if (state !== null) safety.checked.push({ name: "gh", ok: true, detail: `gh reports the PR as ${state}` });
  }
  return safety;
}

/** Internal details for the allocator; public inspection keeps its original object shape. */
export async function inspectReleaseDetails(
  gitRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
  proofMode: ReleaseProof = "git",
  ghTimeoutMs = DEFAULT_GH_TIMEOUT_MS,
  ignoredFiles?: IgnoredFilesPolicy
): Promise<{ safety: WorktreeReleaseSafety; refusalCode?: "unsaved-changes" }> {
  const observations: UnsavedObservation[] = [];
  const policy = { mode: proofMode, ghTimeoutMs, ...(ignoredFiles ? { ignoredFiles } : {}) };
  const safety = await inspectReleaseSafety(gitRoot, worktreePath, branch, baseRef, policy, observations);
  const ordinaryOnly = safety.dirty && !safety.unmerged && observations.every(observation => observation.kind === "changes");
  return { safety, ...(ordinaryOnly ? { refusalCode: "unsaved-changes" as const } : {}) };
}

/**
 * Is it safe to destroy this worktree and its branch?
 *
 * The tree's files go through the same check as park, so a status git cannot
 * read, a hidden untracked file, or an ignored file no build regenerates all
 * count as dirty. A tree already gone from disk has no files left to lose.
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
  baseRef: string,
  releaseProof: ReleaseProof = "git",
  ghTimeoutMs = DEFAULT_GH_TIMEOUT_MS,
  ignoredFiles?: IgnoredFilesPolicy
): Promise<WorktreeReleaseSafety> {
  return (await inspectReleaseDetails(gitRoot, worktreePath, branch, baseRef, releaseProof, ghTimeoutMs, ignoredFiles)).safety;
}

/** The failed checks, as one line a coordinator can act on. */
export function describeRefusal(safety: WorktreeReleaseSafety): string {
  const failed = safety.checked.filter((c) => !c.ok && !(c.name === "pushed" && safety.landed));
  const advisory = safety.checked.filter((c) => c.name === "gh").map((c) => c.detail);
  return [...failed.map((c) => c.detail), ...advisory].join("; ");
}
