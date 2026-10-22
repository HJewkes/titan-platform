import type { GitHubWire, HeadRef, RepoSlug, WriteResult } from "./port.js";

export async function ensureBranch(wire: GitHubWire, repo: RepoSlug, branch: string, baseSha: string): Promise<WriteResult<{ sha: string }>> {
  const existing = await wire.getRef(repo, branch);
  if (existing) return { sha: existing, done: false, skipped: "exists" };
  await wire.createRef(repo, branch, baseSha);
  return { sha: baseSha, done: true };
}

export async function deleteRef(wire: GitHubWire, repo: RepoSlug, head: HeadRef): Promise<WriteResult> {
  if (head.repo === null || head.repo.toLowerCase() !== repo.toLowerCase()) return { done: false, skipped: "fork-head" };
  if (head.branch === (await wire.getDefaultBranch(repo))) return { done: false, skipped: "default-branch" };
  if ((await wire.getRef(repo, head.branch)) === null) return { done: false, skipped: "absent" };
  await wire.deleteRef(repo, head.branch);
  return { done: true };
}
