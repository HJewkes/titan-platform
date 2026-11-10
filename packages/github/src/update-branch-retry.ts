import { httpStatusOf } from "./rest.js";
import { pause, writeWithReadBack, type RetrySchedule } from "./write-read-back.js";
import type { GitHubWire, RepoSlug, WriteResult } from "./port-types.js";
import { closedSkip } from "./close-pr.js";

export async function updateBranch(wire: GitHubWire, repo: RepoSlug, number: number, expectedHeadSha: string): Promise<WriteResult> {
  const pr = await wire.getPr(repo, number);
  const skipped = closedSkip(pr) ?? (pr.headSha !== expectedHeadSha ? "head-moved" : !pr.behind ? "up-to-date" : undefined);
  if (skipped) return { done: false, skipped };
  return sendUpdateBranch(wire, repo, number, expectedHeadSha);
}

/** One write, then an immediate read-back; any other failure of that read-back throws the first PUT's error. */
const UPDATE_BRANCH_SCHEDULE: RetrySchedule = { delays: [0], rawError: true };

/** An unreadable answer or a 5xx may hide a PUT that landed, so it is sent once more with the same expected head: GitHub refuses a landed one as a head mismatch, which reads as done. */
function sendUpdateBranch(wire: GitHubWire, repo: RepoSlug, number: number, expectedHeadSha: string): Promise<WriteResult> {
  const put = async (): Promise<WriteResult> => (await wire.updateBranch(repo, number, expectedHeadSha), { done: true });
  const landed = (): Promise<WriteResult | undefined> => put().catch((error: unknown) => (isHeadMismatch(error) ? { done: true as const } : undefined));
  return writeWithReadBack(`update-branch PUT ${repo}#${number} at ${expectedHeadSha}`, put, landed, pause, UPDATE_BRANCH_SCHEDULE);
}

function isHeadMismatch(error: unknown): boolean {
  return httpStatusOf(error) === 422 && /expected head sha|head (branch )?(was )?(modified|moved)/i.test(error instanceof Error ? error.message : "");
}
