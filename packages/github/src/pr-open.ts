import type { OpenPrRequest } from "./pr-list.js";
import type { GitHubWire, PullRequest, RepoSlug, WriteResult } from "./port.js";

/** An open PR wins; otherwise the newest closed one, so a crash after a merge still finds its PR. */
export async function findPr(wire: GitHubWire, repo: RepoSlug, headBranch: string): Promise<PullRequest | null> {
  const prs = await wire.listPrs(repo, headBranch);
  const newestFirst = [...prs].sort((a, b) => b.number - a.number);
  return newestFirst.find((pr) => pr.state === "open") ?? newestFirst[0] ?? null;
}

export async function openPr(wire: GitHubWire, repo: RepoSlug, request: OpenPrRequest): Promise<WriteResult<{ pr: PullRequest }>> {
  const existing = await findPr(wire, repo, request.head);
  if (existing) return { pr: existing, done: false, skipped: "exists" };
  return { pr: await wire.createPr(repo, request), done: true };
}
