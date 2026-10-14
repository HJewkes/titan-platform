import { GhError } from "./exec.js";
import type { Rest } from "./rest.js";

/**
 * What GitHub's Merges API did with `head`: 201 made a merge commit, 204 found `head` already in the branch, and 409
 * found a conflict. A conflict is an answer, not an error, because a caller building a batch ejects one member and
 * goes on; a contained head is no conflict, so it must never eject.
 */
export type MergeIntoBranchResult = { outcome: "merged"; sha: string } | { outcome: "already-contained" } | { outcome: "conflict" };

export interface MergeIntoBranchRequest {
  /** The branch the merge commit lands on. */
  branch: string;
  /** The commit merged in. */
  head: string;
  /** The merge commit's message; absent, GitHub writes its default. */
  message?: string;
}

/** `POST repos/{r}/merges`. A 204 has no body, a 201 carries the merge commit, and every other status throws but 409. */
export async function sendMergeIntoBranch(api: Rest, repo: string, request: MergeIntoBranchRequest): Promise<MergeIntoBranchResult> {
  const fields = { base: request.branch, head: request.head, ...(request.message === undefined ? {} : { commit_message: request.message }) };
  let answer: unknown;
  try {
    answer = await api.send<unknown>("POST", `repos/${repo}/merges`, {}, JSON.stringify(fields));
  } catch (error) {
    if (error instanceof GhError && error.status === 409) return { outcome: "conflict" };
    throw error;
  }
  return mergeAnswer(answer, repo, request);
}

function mergeAnswer(answer: unknown, repo: string, request: MergeIntoBranchRequest): MergeIntoBranchResult {
  if (answer === undefined || answer === null || answer === "") return { outcome: "already-contained" };
  if (typeof answer === "object" && "sha" in answer && typeof answer.sha === "string") return { outcome: "merged", sha: answer.sha };
  throw new Error(`merging ${request.head} into ${request.branch} on ${repo} answered a body with no merge commit sha`);
}
