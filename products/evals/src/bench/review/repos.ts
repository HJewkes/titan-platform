import { InvalidArgumentError } from "commander";
import { localCloneGit, type BundleGit } from "../../review-pr/bundle.js";

/** `owner/name` to `name`, the key `--repo-root name=path` uses. */
export const repoName = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

/** Commander's collector for a repeatable `--repo-root name=path`. */
export function collectRepoRoot(value: string, previous: Record<string, string> = {}): Record<string, string> {
  const at = value.indexOf("=");
  if (at <= 0 || at === value.length - 1) throw new InvalidArgumentError("expected name=path, as in titan-platform=/srv/clones/titan-platform");
  return { ...previous, [value.slice(0, at)]: value.slice(at + 1) };
}

/** The local clone for a case's repo; jobs and the case builder only ever archive from it, never fetch into it. */
export function cloneGitFor(roots: Readonly<Record<string, string>>): (repo: string) => BundleGit | undefined {
  const ports = new Map<string, BundleGit>();
  return (repo) => {
    const root = roots[repoName(repo)];
    if (root === undefined) return undefined;
    const port = ports.get(root) ?? localCloneGit(root);
    ports.set(root, port);
    return port;
  };
}
