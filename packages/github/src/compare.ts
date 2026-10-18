import { COMPARE_FILE_CAP, type CompareResult } from "./port.js";
import type { Rest } from "./rest.js";

/**
 * Where `head` stands relative to `base`, as GitHub's compare `status` says: `ahead` means `base` is an ancestor of
 * `head`, `behind` the reverse. `missing` is a 404: GitHub does not have one of the commits, which right after a push
 * can mean it has not caught up yet, so it is not proof the commit never existed.
 */
export type Ancestry = "ahead" | "behind" | "identical" | "diverged" | "missing";

const STATUSES: readonly Ancestry[] = ["ahead", "behind", "identical", "diverged"];

const isStatus = (status: unknown): status is Ancestry => STATUSES.some((known) => known === status);

/** One page of one commit is enough: only `status` is read, and it covers the whole range. */
export async function readAncestry(api: Rest, repo: string, base: string, head: string): Promise<Ancestry> {
  const compare = await api.getOrNull<{ status?: unknown }>(`repos/${repo}/compare/${base}...${head}`, { per_page: "1" });
  if (compare === null) return "missing";
  if (isStatus(compare.status)) return compare.status;
  throw new Error(`compare ${base}...${head} on ${repo} answered status ${JSON.stringify(compare.status)}, which is no known ancestry`);
}

interface GhComparePage {
  merge_base_commit: { sha: string };
  total_commits?: number;
  commits?: unknown[];
  files?: { filename: string }[];
}

/** Every page repeats the merge base and total; files and commits are split across pages. */
export async function compareFiles(api: Rest, repo: string, base: string, head: string): Promise<CompareResult> {
  let mergeBaseSha = "";
  let totalCommits = 0;
  let commitsSeen = 0;
  const files = await api.pages(`repos/${repo}/compare/${base}...${head}`, { per_page: "100" }, (page: GhComparePage) => {
    mergeBaseSha = page.merge_base_commit.sha;
    totalCommits = page.total_commits ?? 0;
    commitsSeen += page.commits?.length ?? 0;
    return (page.files ?? []).map((file) => file.filename);
  });
  return { mergeBaseSha, files, truncated: files.length >= COMPARE_FILE_CAP || totalCommits > commitsSeen };
}
