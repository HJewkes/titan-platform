import type { GitHubPort } from "@titan-design/github";
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

/** update-branch is asynchronous on GitHub, so the step waits for the head to move before it reports one. */
export async function updateBranch(port: GitHubPort, input: UpdateInput, timing: Timing, signal: AbortSignal): Promise<UpdateResult> {
  for (let resend = 0; ; resend++) {
    const write = await port.updateBranch(input.repo, input.pr, input.expectedHeadSha).catch(conflictOrThrow);
    if (write === "conflict") return { headSha: input.expectedHeadSha, own: false, conflict: true };
    if (!write.done && write.skipped !== "head-moved") {
      const pr = await port.getPr(input.repo, input.pr);
      return { headSha: pr.headSha, own: pr.headSha === input.expectedHeadSha, skipped: write.skipped };
    }
    const headSha = await waitForHeadChange(port, input, timing, signal);
    if (headSha !== undefined) return movedHead(port, input, headSha, write.done ? undefined : write.skipped);
    if (resend === UPDATE_RESENDS) return { headSha: input.expectedHeadSha, own: false, unmoved: true };
  }
}

async function movedHead(port: GitHubPort, input: UpdateInput, headSha: string, skipped: string | undefined): Promise<UpdateResult> {
  const commit = await port.getCommit(input.repo, headSha);
  const own = commit.parents.length === 2 && commit.parents[0] === input.expectedHeadSha;
  return { headSha, own, ...(skipped === undefined ? {} : { skipped }) };
}

/** The head that replaced the expected one, or undefined when the wait ran out with it unmoved. */
async function waitForHeadChange(port: GitHubPort, input: UpdateInput, timing: Timing, signal: AbortSignal): Promise<string | undefined> {
  const clock = deadline(timing);
  for (;;) {
    const pr = await port.getPr(input.repo, input.pr);
    if (pr.headSha !== input.expectedHeadSha) return pr.headSha;
    if (clock.expired()) return undefined;
    await clock.sleep(Math.min(timing.pollMs, 5_000), signal);
  }
}
