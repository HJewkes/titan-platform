import { isTransient } from "./rest.js";
import type { GitHubWire, RepoSlug, WriteResult } from "./port.js";

/** An unreadable answer or a 5xx may hide a PUT that landed, so it is sent once more with the same expected head: GitHub refuses a landed one as a head mismatch, which reads as done. */
export async function sendUpdateBranch(wire: GitHubWire, repo: RepoSlug, number: number, expectedHeadSha: string): Promise<WriteResult> {
  try {
    await wire.updateBranch(repo, number, expectedHeadSha);
    return { done: true };
  } catch (error) {
    if (!isRetryableWrite(error)) throw error;
    return retryUpdateBranch(wire, repo, number, expectedHeadSha, error);
  }
}

async function retryUpdateBranch(wire: GitHubWire, repo: RepoSlug, number: number, expectedHeadSha: string, original: unknown): Promise<WriteResult> {
  try {
    await wire.updateBranch(repo, number, expectedHeadSha);
  } catch (error) {
    if (isHeadMismatch(error)) return { done: true };
    throw original;
  }
  return { done: true };
}

export function isRetryableWrite(error: unknown): boolean {
  return isTransient(error) || (httpStatusOf(error) ?? 0) >= 500;
}

function isHeadMismatch(error: unknown): boolean {
  return httpStatusOf(error) === 422 && /expected head sha|head (branch )?(was )?(modified|moved)/i.test(error instanceof Error ? error.message : "");
}

function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}
