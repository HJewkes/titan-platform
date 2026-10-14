import type { GitHubWire, PrFile, RepoSlug } from "./port.js";

/** The list came back shorter than the PR's own count, so a path may be missing. */
export class FileListTruncatedError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`GitHub listed ${received} of ${expected} changed files; the PR is past its list cap, so do not decide from a partial list`);
    this.name = "FileListTruncatedError";
  }
}

export async function listPrFiles(wire: GitHubWire, repo: RepoSlug, number: number): Promise<PrFile[]> {
  const { files, changedFiles } = await wire.listPrFiles(repo, number);
  if (files.length < changedFiles) throw new FileListTruncatedError(changedFiles, files.length);
  return files;
}
