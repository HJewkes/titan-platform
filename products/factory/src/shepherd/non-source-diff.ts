import { PR_FILES_CAP, type GitHubPort, type PrFile, type RepoSlug } from "@titan-design/github";

/** Tests (mutation specs included), workflows, changesets and docs: paths no fix-proof run can reproduce a bug in. */
const NON_SOURCE: readonly RegExp[] = [/\.test\.[^/]+$/, /(^|\/)__tests__\//, /^\.github\/workflows\//, /^\.changeset\//, /(^|\/)docs\//, /\.md$/];

export const isNonSourcePath = (path: string): boolean => NON_SOURCE.some((pattern) => pattern.test(path));

const pathsOf = (files: readonly PrFile[]): string[] => files.flatMap((file) => [file.path, file.previousPath ?? file.path]);

/**
 * True only when the PR's file list, read in full while its head is still `head`, names non-source paths alone. A list that is
 * empty, at GitHub's cap or unreadable, or a head that moved, reads false, so the NO_REPRO stands.
 */
export async function nonSourceDiff(port: GitHubPort, repo: RepoSlug, pr: number | null, head: string): Promise<boolean> {
  if (pr === null) return false;
  try {
    const files = await port.listPrFiles(repo, pr);
    if (files.length === 0 || files.length >= PR_FILES_CAP || !pathsOf(files).every(isNonSourcePath)) return false;
    return (await port.getPr(repo, pr)).headSha === head;
  } catch {
    return false;
  }
}
