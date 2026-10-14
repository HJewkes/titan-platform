import { FileListTruncatedError, type GitHubPort, type PrFile, type RepoSlug } from "@titan-design/github";
import { statusOf } from "../required-checks.js";

/** Both sides of every rename, so moving a file out of `.github/` still counts as touching it. */
function changedPaths(files: readonly PrFile[]): string[] {
  return files.flatMap((file) => (file.previousPath === undefined ? [file.path] : [file.path, file.previousPath]));
}

interface PathsRead {
  paths: string[];
  /** Why the list could not be read whole. */
  unread?: string;
}

/**
 * A truncated or failed list is no list: empty paths fail authority's path condition, and the unread reason gates first.
 * GitHub lists a PR's files at whatever head it has now, so the list counts only when the PR sits at `head` both before
 * and after it is read. The compare endpoint would pin the sha itself, but it drops rename sources and stops at 300 files.
 */
export async function pinnedPaths(port: GitHubPort, { repo, pr, head }: { repo: RepoSlug; pr: number; head: string }, readHead: string): Promise<PathsRead> {
  const unread = (why: string): PathsRead => ({ paths: [], unread: `the changed files of ${repo}#${pr} are unknown: ${why}` });
  if (readHead !== head) return unread(`the PR is at ${readHead}, not ${head}`);
  try {
    const files = await port.listPrFiles(repo, pr);
    const after = (await port.getPr(repo, pr)).headSha;
    return after === head ? { paths: changedPaths(files) } : unread(`the head moved to ${after} during the read`);
  } catch (error) {
    return unread(error instanceof FileListTruncatedError ? "the list is truncated" : `the read failed: ${statusOf(error)}`);
  }
}
