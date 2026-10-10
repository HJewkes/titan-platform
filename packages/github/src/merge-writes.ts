import { writeWithReadBack, type Sleep } from "./write-read-back.js";
import type { MergeMessage } from "./port-types.js";
import type { GitHubWire, MergeMethod, RepoSlug, WriteResult } from "./port.js";

type MergeResult = WriteResult<{ mergeSha: string }>;

const BASE_CHANGED: MergeResult = { mergeSha: "", done: false, skipped: "base-changed" };

export async function merge(wire: GitHubWire, repo: RepoSlug, number: number, sha: string, method: MergeMethod, sleep: Sleep, message?: MergeMessage, expectedBase?: string): Promise<MergeResult> {
  const pr = await wire.getPr(repo, number);
  if (pr.merged) return { mergeSha: pr.mergeSha ?? "", done: false, skipped: "merged" };
  if (pr.state === "closed") return { mergeSha: "", done: false, skipped: "closed" };
  if (pr.headSha !== sha) return { mergeSha: "", done: false, skipped: "head-moved" };
  if (expectedBase !== undefined && pr.baseRef !== expectedBase) return BASE_CHANGED;
  let attempts = 0;
  const put = async (): Promise<MergeResult> => {
    if (attempts++ > 0 && expectedBase !== undefined && (await wire.getPr(repo, number)).baseRef !== expectedBase) return BASE_CHANGED;
    return { mergeSha: (await wire.merge(repo, number, sha, method, message)).sha, done: true };
  };
  return writeWithReadBack(`merge PUT ${repo}#${number} at ${sha}`, put, () => mergedAt(wire, repo, number, sha), sleep);
}

/** Only a merge of the pinned head counts as this write landing. */
async function mergedAt(wire: GitHubWire, repo: RepoSlug, number: number, sha: string): Promise<WriteResult<{ mergeSha: string }> | undefined> {
  const pr = await wire.getPr(repo, number);
  return pr.merged && pr.headSha === sha && pr.mergeSha ? { mergeSha: pr.mergeSha, done: true } : undefined;
}

export async function rerunFailed(wire: GitHubWire, repo: RepoSlug, runId: number, sleep: Sleep): Promise<WriteResult> {
  const status = await wire.getWorkflowRunStatus(repo, runId);
  if (status !== "completed") return { done: false, skipped: "in-progress" };
  const requeued = async () => ((await wire.getWorkflowRunStatus(repo, runId)) === "completed" ? undefined : { done: true as const });
  return writeWithReadBack(`rerun-failed-jobs ${repo} run ${runId}`, async () => (await wire.rerunFailedJobs(repo, runId), { done: true as const }), requeued, sleep);
}
