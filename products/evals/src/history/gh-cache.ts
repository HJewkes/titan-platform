import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { excludedReason, PER_REPO_LIMIT, pinWindow, type WindowPr } from "./label-v2.js";

/** Extra PRs the Python builder listed past the window, so a window pinned in the past still has 60 PRs to pick from. */
const WINDOW_SLACK = 40;

const nullableText = z.string().nullish();

const RestPull = z.object({
  number: z.number(),
  title: z.string().nullable(),
  body: nullableText,
  state: z.string(),
  created_at: z.string(),
  merged_at: nullableText,
  closed_at: nullableText,
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
  user: z.object({ login: z.string(), type: z.string() }),
  merge_commit_sha: z.string().nullable(),
});
type RestPull = z.infer<typeof RestPull>;

const RestDetail = z.object({ additions: z.number(), deletions: z.number(), changed_files: z.number() });
const RestFiles = z.array(z.object({ filename: z.string() }));
const RestReviews = z.array(z.object({ state: z.string(), submitted_at: nullableText }));
const RestComments = z.array(z.object({ created_at: z.string(), body: nullableText }));
const RestCommits = z.array(
  z.object({ sha: z.string(), commit: z.object({ message: z.string().nullable(), committer: z.object({ date: z.string().nullable() }) }) }),
);

interface WindowRequest {
  owner: string;
  repo: string;
  asOf: string;
}

/** The file name the Python `gh_cached` wrote for one REST path. */
export function cacheFileName(path: string): string {
  return `${path.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
}

/** Reads one cached REST response; a missing file is an error, never a fetch. */
function readCached<T extends z.ZodType>(cacheDir: string, path: string, schema: T): z.infer<T> {
  const file = join(cacheDir, cacheFileName(path));
  if (!existsSync(file)) throw new Error(`gh-cache has no ${cacheFileName(path)} for ${path}; this reader never fetches`);
  return schema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function fromRest(item: RestPull): WindowPr {
  const merged = item.merged_at ?? null;
  return {
    number: item.number,
    title: item.title,
    body: item.body ?? null,
    state: item.state === "open" ? "OPEN" : merged ? "MERGED" : "CLOSED",
    createdAt: item.created_at,
    mergedAt: merged,
    closedAt: item.closed_at ?? null,
    headRefName: item.head.ref,
    baseRefName: item.base.ref,
    author: { login: item.user.login, is_bot: item.user.type === "Bot" },
    mergeCommit: merged ? { oid: item.merge_commit_sha } : null,
  };
}

function detailFields(cacheDir: string, base: string, n: number): Partial<WindowPr> {
  const detail = readCached(cacheDir, `${base}/pulls/${n}`, RestDetail);
  const reviews = readCached(cacheDir, `${base}/pulls/${n}/reviews?per_page=100`, RestReviews);
  const comments = readCached(cacheDir, `${base}/issues/${n}/comments?per_page=100`, RestComments);
  const commits = readCached(cacheDir, `${base}/pulls/${n}/commits?per_page=100`, RestCommits);
  return {
    additions: detail.additions,
    deletions: detail.deletions,
    changedFiles: detail.changed_files,
    reviews: reviews.map((r) => ({ state: r.state, submittedAt: r.submitted_at ?? null })),
    comments: comments.map((c) => ({ createdAt: c.created_at, body: c.body ?? null })),
    commits: commits.map((c) => ({
      oid: c.sha,
      committedDate: c.commit.committer.date,
      messageHeadline: (c.commit.message ?? "").split("\n")[0] ?? "",
    })),
  };
}

/** Changed files for every PR in the window; size, reviews, comments and commits only for would-be cases. */
function withDetails(cacheDir: string, base: string, pr: WindowPr): WindowPr {
  const files = readCached(cacheDir, `${base}/pulls/${pr.number}/files?per_page=100`, RestFiles);
  const listed = { ...pr, files: files.map((f) => f.filename) };
  return excludedReason(listed) ? listed : { ...listed, ...detailFields(cacheDir, base, pr.number) };
}

/** One repo's v2 window at `asOf`, read from the cache the 2026-09-28 Python run wrote. */
export function loadWindow(cacheDir: string, { owner, repo, asOf }: WindowRequest): WindowPr[] {
  const base = `repos/${owner}/${repo}`;
  const listSize = PER_REPO_LIMIT + WINDOW_SLACK;
  const path = `${base}/pulls?state=all&sort=created&direction=desc&per_page=${listSize}`;
  const listed = readCached(cacheDir, path, z.array(RestPull)).map(fromRest);
  const pinned = pinWindow(listed, asOf);
  if (pinned.length < PER_REPO_LIMIT && listed.length === listSize) {
    throw new Error(`window for ${asOf} reaches past the cached ${listed.length} PRs of ${repo}`);
  }
  return pinned.map((pr) => withDetails(cacheDir, base, pr));
}
