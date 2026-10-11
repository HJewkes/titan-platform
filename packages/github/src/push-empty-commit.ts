import type { GitHubWire, RepoSlug, WriteResult } from "./port.js";

export async function pushEmptyCommit(wire: GitHubWire, repo: RepoSlug, branch: string, expectedHeadSha: string, message: string): Promise<WriteResult<{ sha: string }>> {
  const head = await wire.getRef(repo, branch);
  if (head !== expectedHeadSha) return { sha: head ?? "", done: false, skipped: head === null ? "absent" : "head-moved" };
  const { tree } = await wire.getCommit(repo, expectedHeadSha);
  if (tree === undefined) throw new Error(`commit ${expectedHeadSha} in ${repo} reports no tree`);
  const created = await wire.createCommit(repo, { message, tree, parents: [expectedHeadSha] });
  await wire.updateRef(repo, branch, created.sha);
  return { sha: created.sha, done: true };
}
