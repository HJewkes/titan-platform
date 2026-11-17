import { approvedHeadWalk, type CleanMergeTree, type GitHubPort, type WriteResult } from "@titan-design/github";
import { deadline } from "./deadline.js";
import { conflictOrThrow } from "./land-steps.js";
import type { Timing } from "./land.js";

interface UpdateResult {
  headSha: string;
  /** The new head is GitHub's merge of the expected head and the base, so it adds nothing a human has not seen. */
  own: boolean;
  skipped?: string;
  /** GitHub refused the update because the base does not merge into the head; the head is unchanged. */
  conflict?: boolean;
  /** GitHub accepted the update but the head never moved, even after the bounded re-reads and re-sends. */
  unmoved?: boolean;
}

export interface UpdateInput {
  repo: string;
  pr: number;
  expectedHeadSha: string;
}

/** GitHub's update-branch sometimes never moves the head on the first write; each re-send follows a fresh read of the PR. */
export const UPDATE_RESENDS = 2;

/** One update-branch write: a merge of the base into the head, never a rebase or a force push; GitHub's 422 for an unmergeable base is `conflict`. */
export function requestUpdate(port: GitHubPort, input: UpdateInput): Promise<WriteResult | "conflict"> {
  return port.updateBranch(input.repo, input.pr, input.expectedHeadSha).catch(conflictOrThrow);
}

/** Computes git's clean merge-tree in `repo`; absent, no moved head is `own`, so the owner is asked again. */
export type MergeUpTree = (repo: string, signal: AbortSignal) => CleanMergeTree;

/** update-branch is asynchronous on GitHub, so the step waits for the head to move before it reports one. */
export async function updateBranch(port: GitHubPort, input: UpdateInput, timing: Timing, signal: AbortSignal, mergeUpTree?: MergeUpTree): Promise<UpdateResult> {
  for (let resend = 0; ; resend++) {
    const write = await requestUpdate(port, input);
    if (write === "conflict") return { headSha: input.expectedHeadSha, own: false, conflict: true };
    if (!write.done && write.skipped !== "head-moved") {
      const pr = await port.getPr(input.repo, input.pr);
      return { headSha: pr.headSha, own: pr.headSha === input.expectedHeadSha, skipped: write.skipped };
    }
    const moved = await waitForHeadChange(port, input, timing, signal);
    if (moved !== undefined) return movedHead(port, input, moved, write.done ? undefined : write.skipped, mergeUpTree?.(input.repo, signal), signal);
    if (resend === UPDATE_RESENDS) return { headSha: input.expectedHeadSha, own: false, unmoved: true };
  }
}

interface MovedHead {
  headSha: string;
  baseRef: string;
}

async function movedHead(port: GitHubPort, input: UpdateInput, moved: MovedHead, skipped: string | undefined, cleanMergeTree: CleanMergeTree | undefined, signal: AbortSignal): Promise<UpdateResult> {
  const own = await isOwnMergeUp(port, input, moved, cleanMergeTree, signal);
  return { headSha: moved.headSha, own, ...(skipped === undefined ? {} : { skipped }) };
}

/**
 * A head pushed between ci-wait's behind read and this write also has the expected head as a parent, so the shape proves
 * nothing (TP-6006): the head is `own` only when its first parent is the expected head, its second is on the base branch,
 * and its tree is git's clean merge of the two. A failed read answers no, so approve-merge asks again.
 */
async function isOwnMergeUp(port: GitHubPort, input: UpdateInput, moved: MovedHead, cleanMergeTree: CleanMergeTree | undefined, signal: AbortSignal): Promise<boolean> {
  if (cleanMergeTree === undefined) return false;
  try {
    const { parents } = await port.getCommit(input.repo, moved.headSha);
    if (parents.length !== 2 || parents[0] !== input.expectedHeadSha) return false;
    const walk = await approvedHeadWalk(port, input.repo, { headSha: moved.headSha, approvedHead: input.expectedHeadSha, baseRef: moved.baseRef, maxBaseMerges: 1, cleanMergeTree });
    return walk.ok;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

/** The head that replaced the expected one, or undefined when the wait ran out with it unmoved. */
async function waitForHeadChange(port: GitHubPort, input: UpdateInput, timing: Timing, signal: AbortSignal): Promise<MovedHead | undefined> {
  const clock = deadline(timing);
  for (;;) {
    const pr = await port.getPr(input.repo, input.pr);
    if (pr.headSha !== input.expectedHeadSha) return { headSha: pr.headSha, baseRef: pr.baseRef };
    if (clock.expired()) return undefined;
    await clock.sleep(Math.min(timing.pollMs, 5_000), signal);
  }
}
