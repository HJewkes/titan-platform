import { FileListTruncatedError, PR_FILES_CAP, type GitHubPort, type PrFile, type RepoSlug } from "./port.js";

export interface PrContext {
  repo: RepoSlug;
  number: number;
  title: string;
  baseRef: string;
  headSha: string;
  /** Empty when `truncated`: a partial list would read as the whole change. */
  files: PrFile[];
  /** The PR's own changed-file count when it is past GitHub's file-list cap; null when `files` is complete. */
  truncated: { changedFiles: number } | null;
  body: string;
}

/** What a reviewer reads first: the PR's title, base, head, changed files and body. */
export async function prContext(port: GitHubPort, repo: RepoSlug, number: number): Promise<PrContext> {
  const [pr, source, listed] = await Promise.all([port.getPr(repo, number), port.getSquashSource(repo, number), changedFiles(port, repo, number)]);
  return { repo, number: pr.number, title: source.title, baseRef: pr.baseRef, headSha: pr.headSha, ...listed, body: source.body };
}

export function formatPrContext(context: PrContext): string {
  const files = context.truncated
    ? [`files: ${context.truncated.changedFiles} changed, past GitHub's ${PR_FILES_CAP}-file list cap, so none are listed`]
    : [`files (${context.files.length}):`, ...context.files.map(formatFile)];
  return [`${context.repo}#${context.number} ${context.title}`, `base: ${context.baseRef}`, `head: ${context.headSha}`, ...files, "", context.body || "(no body)"].join("\n");
}

async function changedFiles(port: GitHubPort, repo: RepoSlug, number: number): Promise<Pick<PrContext, "files" | "truncated">> {
  try {
    return { files: await port.listPrFiles(repo, number), truncated: null };
  } catch (error) {
    if (!(error instanceof FileListTruncatedError)) throw error;
    return { files: [], truncated: { changedFiles: error.expected } };
  }
}

function formatFile(file: PrFile): string {
  const counts = file.additions === undefined || file.deletions === undefined ? "" : ` +${file.additions} -${file.deletions}`;
  const path = file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
  return `  ${file.status} ${path}${counts}`;
}
