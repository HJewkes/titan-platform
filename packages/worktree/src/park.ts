import { fetchDefaultTip } from "./branch-base.js";
import { gitOrNull, gitText as git } from "./git.js";
import { DEFAULT_FETCH_TIMEOUT_MS, type WorktreeOptions } from "./options.js";
import type { WorktreeRecord } from "./reattach.js";
import { unsavedWork } from "./unsaved-work.js";

/** Parking keeps the local branch; an opt-in fresh default proof can establish its commits are already backed. */
export interface ParkOptions {
  /** Permit a missing origin/branch only when a fresh DEFAULT fetch contains the actual HEAD. */
  allowDefaultBranchAncestor?: boolean;
  /** Positive finite fetch budget; invalid values refuse without fetching. Defaults to 15 seconds. */
  fetchTimeoutMs?: WorktreeOptions["fetchTimeoutMs"];
}

interface PushProof {
  refusal?: string;
  provedHead?: string;
}

const missingBranch = (target: WorktreeRecord): string =>
  `${target.branch} is not on origin; push it first`;

/** Only a strict fetched tip can back the actual current HEAD; local fallback is not evidence. */
async function defaultAncestryProof(
  target: WorktreeRecord,
  options: ParkOptions
): Promise<PushProof> {
  const timeout = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (
    options.allowDefaultBranchAncestor !== true ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  )
    return { refusal: missingBranch(target) };
  const tip = await fetchDefaultTip(target.worktree, timeout);
  const head =
    typeof tip === "string"
      ? null
      : await gitOrNull(
          ["rev-parse", "--verify", "HEAD^{commit}"],
          target.worktree
        );
  if (
    typeof tip === "string" ||
    head === null ||
    (await gitOrNull(
      ["merge-base", "--is-ancestor", head, tip.sha],
      target.worktree
    )) === null
  )
    return { refusal: missingBranch(target) };
  return { provedHead: head };
}

/** With an origin, the branch must be backed there; without one, the kept local branch is the copy. */
async function unpushed(
  target: WorktreeRecord,
  options: ParkOptions
): Promise<PushProof> {
  const { worktree, branch } = target;
  if ((await gitOrNull(["remote", "get-url", "origin"], worktree)) === null)
    return {};
  if (
    (await gitOrNull(
      ["rev-parse", "--verify", "--quiet", `origin/${branch}`],
      worktree
    )) === null
  )
    return defaultAncestryProof(target, options);
  const ahead = await gitOrNull(
    ["rev-list", `origin/${branch}..HEAD`],
    worktree
  );
  if (ahead === null)
    return { refusal: `could not compare ${worktree} with origin/${branch}` };
  const count = ahead.split("\n").filter(Boolean).length;
  return count === 0
    ? {}
    : {
        refusal: `${count} commit(s) in ${worktree} are not on origin/${branch}; push first`,
      };
}

/** A commit on another branch would lose the expected branch relationship when the tree is removed. */
async function offBranch(target: WorktreeRecord): Promise<string | undefined> {
  const head = await gitOrNull(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    target.worktree
  );
  if (head === target.branch) return undefined;
  const where = head === null ? "detached" : `on ${head}`;
  return `HEAD in ${target.worktree} is ${where}, not on ${target.branch}; check out ${target.branch} first`;
}

/** Async fetch and caller checks can outlive the initial snapshot; keep the proof bound to files, branch and HEAD. */
async function proofChanged(
  target: WorktreeRecord,
  provedHead: string
): Promise<string | undefined> {
  const refusal =
    (await unsavedWork(target.worktree)) ?? (await offBranch(target));
  if (refusal) return refusal;
  const head = await gitOrNull(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    target.worktree
  );
  return head === provedHead ? undefined : missingBranch(target);
}

async function removeParked(
  target: WorktreeRecord,
  head: string
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  try {
    await git(["worktree", "remove", target.worktree], target.gitRoot);
  } catch (err) {
    const detail = String(
      (err as { stderr?: unknown }).stderr || (err as Error).message
    ).trim();
    return {
      ok: false,
      reason: `git would not remove ${target.worktree}: ${
        detail.split("\n")[0]
      }`,
    };
  }
  return { ok: true, head };
}

/** Refuse file loss, recheck lifecycle immediately before nonforced removal, and always keep the local branch. */
export async function parkWorktree(
  target: WorktreeRecord,
  recheck: () => string | undefined = () => undefined,
  options: ParkOptions = {}
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const refusal =
    (await offBranch(target)) ?? (await unsavedWork(target.worktree));
  if (refusal) return { ok: false, reason: refusal };
  const proof = await unpushed(target, options);
  if (proof.refusal) return { ok: false, reason: proof.refusal };
  const changed =
    proof.provedHead === undefined
      ? undefined
      : await proofChanged(target, proof.provedHead);
  if (changed) return { ok: false, reason: changed };
  const head =
    proof.provedHead ?? (await git(["rev-parse", "HEAD"], target.worktree));
  const late = recheck();
  if (late) return { ok: false, reason: late };
  const final =
    proof.provedHead === undefined
      ? undefined
      : await proofChanged(target, proof.provedHead);
  if (final) return { ok: false, reason: final };
  return removeParked(target, head);
}
