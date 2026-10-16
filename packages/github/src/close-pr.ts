import type { GitHubWire, PullRequest, RepoSlug, SkipReason, WriteResult } from "./port.js";

export function closedSkip(pr: PullRequest): SkipReason | undefined {
  if (pr.merged) return "merged";
  return pr.state === "closed" ? "closed" : undefined;
}

export async function closePr(wire: GitHubWire, repo: RepoSlug, number: number): Promise<WriteResult> {
  const skipped = closedSkip(await wire.getPr(repo, number));
  if (skipped) return { done: false, skipped };
  await wire.closePr(repo, number);
  return { done: true };
}
