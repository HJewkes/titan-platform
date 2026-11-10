import type { BranchCommit, GitHubPort, RepoSlug } from "@titan-design/github";

export const BUMP_TITLE = "Bump @titan-design dependencies to npm latest";

/** The sweep writes one file per commit through the contents API, and says which in the message. */
export const bumpCommitMessage = (path: string): string => `${BUMP_TITLE}: ${path}`;

const sameLogin = (login: string | null, actor: string): boolean => login !== null && login.toLowerCase() === actor.toLowerCase();

type CommitMessage = (path: string) => string;

function isSweepCommit(commit: BranchCommit, actor: string, paths: ReadonlySet<string>, messageOf: CommitMessage): boolean {
  if (!sameLogin(commit.authorLogin, actor) || !sameLogin(commit.committerLogin, actor)) return false;
  return [...paths].some((path) => commit.message === messageOf(path));
}

/**
 * True only when every commit `branch` holds past `base` is one the sweep itself would write: authored and committed by the
 * port's own login, with the sweep's message (`messageOf`, the bump's by default) for one of `paths`, and the branch changing
 * nothing outside `paths`. A truncated compare is never trusted.
 */
export async function isSweepOnlyBranch(port: Pick<GitHubPort, "actorLogin" | "listBranchCommits">, repo: RepoSlug, base: string, branch: string, paths: ReadonlySet<string>, messageOf: CommitMessage = bumpCommitMessage): Promise<boolean> {
  const [actor, compared] = await Promise.all([port.actorLogin(), port.listBranchCommits(repo, base, branch)]);
  if (compared.truncated) return false;
  return compared.files.every((path) => paths.has(path)) && compared.commits.every((commit) => isSweepCommit(commit, actor, paths, messageOf));
}
