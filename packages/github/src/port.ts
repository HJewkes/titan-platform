import { latestPerName } from "./checks.js";
import type { CreateCheckRunRequest } from "./check-run-create.js";
import type { OpenPrList, OpenPrRequest } from "./pr-list.js";
import type { ReviewComment } from "./review-comment.js";
import { checkConclusion, checkMarker, checkMergeMethod, checkPath, checkPositiveInt, checkRef, checkRepo, checkSha } from "./validate.js";

/** `owner/name`. */
export type RepoSlug = string;

export type MergeMethod = "merge" | "squash" | "rebase";

export interface RepoFile {
  path: string;
  blobSha: string;
  content: string;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  /** Meaningful once `merged`; GitHub also fills it with a test merge while the PR is open. */
  mergeSha: string | null;
  headRef: string;
  headSha: string;
  /** `owner/name` of the repo the head lives in; null when that fork was deleted. */
  headRepo: RepoSlug | null;
  baseRef: string;
  draft: boolean;
  /** GitHub computes this lazily, so `unknown` is common and never means clean. */
  mergeableState: string;
  /** The head lacks commits the base has. */
  behind: boolean;
}

export interface RequiredChecks {
  contexts: string[];
  /** The ruleset requires the branch to be up to date before merging. */
  strict: boolean;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  /** The commit the run checked; a run at any other sha says nothing about this head. */
  headSha: string;
  /** The GitHub App that posted the run; a required context counts only from an allowed app. */
  appId: number | null;
  /** The Actions run that owns this job, for `rerunFailed`; null for non-Actions checks. */
  workflowRunId: number | null;
  url: string;
}

export interface Commit {
  sha: string;
  parents: string[];
  /** The tree the commit records; absent when the wire does not report it. */
  tree?: string;
  /** The committer date; for a commit GitHub made on merge, when it landed. Absent when the wire does not report it. */
  committedAt?: string;
}

export interface PutFileRequest {
  path: string;
  branch: string;
  content: string;
  message: string;
  /** The blob this write replaces; null when the file must not exist yet. */
  expectedBlobSha: string | null;
}

/** A PR's head as GitHub reports it, so a delete can tell a same-named branch in a fork from its own. */
export interface HeadRef {
  branch: string;
  repo: RepoSlug | null;
}

/** One changed file of a PR; a rename carries the path it came from. */
export interface PrFile {
  path: string;
  previousPath?: string;
  status: string;
}

export interface CompareResult {
  mergeBaseSha: string;
  /** Paths changed between the merge base and `head`. */
  files: string[];
  /** GitHub caps compare at 300 files and 250 commits without saying so; when true, `files` may be missing paths. */
  truncated: boolean;
}

/** GitHub's limits for the compare API. */
export const COMPARE_FILE_CAP = 300;
export const COMPARE_COMMIT_CAP = 250;
/** GitHub's limit for `pulls/{n}/files`. */
export const PR_FILES_CAP = 3000;
/** GitHub's limit for `pulls/{n}/commits`. */
export const PR_COMMITS_CAP = 250;

export interface IssueComment {
  id: number;
  body: string;
  /** Login of the commenter. */
  author: string;
}

/**
 * One GitHub call per method, unconditional, as GitHub itself behaves. `gh-cli.ts` and the test
 * fake implement it; `githubPort` puts the check-then-act rules on top of either.
 */
export interface GitHubWire {
  getRef(repo: RepoSlug, branch: string): Promise<string | null>;
  createRef(repo: RepoSlug, branch: string, sha: string): Promise<void>;
  createCommit(repo: RepoSlug, request: { message: string; tree: string; parents: string[] }): Promise<{ sha: string }>;
  /** Moves `branch` to `sha`; GitHub refuses a move that is not a fast-forward. */
  updateRef(repo: RepoSlug, branch: string, sha: string): Promise<void>;
  deleteRef(repo: RepoSlug, branch: string): Promise<void>;
  getDefaultBranch(repo: RepoSlug): Promise<string>;
  getContent(repo: RepoSlug, path: string, ref: string): Promise<RepoFile | null>;
  putContent(repo: RepoSlug, request: PutFileRequest): Promise<{ blobSha: string }>;
  listPrs(repo: RepoSlug, headBranch: string): Promise<PullRequest[]>;
  listOpenPrs(repo: RepoSlug): Promise<PullRequest[]>;
  /** Sent with `If-None-Match: etag` when `etag` is set; GitHub charges a 304 no rate-limit point. */
  revalidateOpenPrs(repo: RepoSlug, etag: string | null): Promise<OpenPrList>;
  createPr(repo: RepoSlug, request: OpenPrRequest): Promise<PullRequest>;
  getPr(repo: RepoSlug, number: number): Promise<PullRequest>;
  getBranchRules(repo: RepoSlug, branch: string): Promise<RequiredChecks>;
  reviewRulesBypassable(repo: RepoSlug, branch: string): Promise<boolean>;
  listCheckRuns(repo: RepoSlug, sha: string): Promise<CheckRun[]>;
  /** Posts a completed check run as the GitHub App the wire was given a token for; the wire refuses when it has none. */
  createCheckRun(repo: RepoSlug, request: CreateCheckRunRequest): Promise<{ id: number }>;
  getCommit(repo: RepoSlug, sha: string): Promise<Commit>;
  getWorkflowRunStatus(repo: RepoSlug, runId: number): Promise<string>;
  getJobLog(repo: RepoSlug, jobId: number): Promise<string>;
  updateBranch(repo: RepoSlug, number: number, expectedHeadSha: string): Promise<void>;
  merge(repo: RepoSlug, number: number, sha: string, method: MergeMethod): Promise<{ sha: string }>;
  rerunFailedJobs(repo: RepoSlug, runId: number): Promise<void>;
  /** `changedFiles` is the PR's own count, so the port can tell a capped list from a complete one. */
  listPrFiles(repo: RepoSlug, number: number): Promise<{ files: PrFile[]; changedFiles: number }>;
  /** The PR's commit shas, oldest first; GitHub returns at most the first 250. */
  listPrCommits(repo: RepoSlug, number: number): Promise<string[]>;
  compareFiles(repo: RepoSlug, base: string, head: string): Promise<CompareResult>;
  getAuthenticatedLogin(): Promise<string>;
  listIssueComments(repo: RepoSlug, number: number): Promise<IssueComment[]>;
  createComment(repo: RepoSlug, number: number, body: string): Promise<{ id: number }>;
  listReviewComments(repo: RepoSlug, number: number): Promise<ReviewComment[]>;
}

export type SkipReason = "exists" | "unchanged" | "merged" | "closed" | "head-moved" | "up-to-date" | "in-progress" | "absent" | "default-branch" | "fork-head";

/** A write either happened now or was skipped because its effect is already in place (or can no longer apply). */
export type WriteResult<T = object> = T & ({ done: true } | { done: false; skipped: SkipReason });

/** Every write reads first, so repeating one after a crash is a no-op. */
export interface GitHubPort {
  getHeadSha(repo: RepoSlug, branch: string): Promise<string | null>;
  ensureBranch(repo: RepoSlug, branch: string, baseSha: string): Promise<WriteResult<{ sha: string }>>;
  /** Refuses (skips) the default branch and a head that lives in another repo. */
  deleteRef(repo: RepoSlug, head: HeadRef): Promise<WriteResult>;
  getFile(repo: RepoSlug, path: string, ref: string): Promise<RepoFile | null>;
  putFile(repo: RepoSlug, request: PutFileRequest): Promise<WriteResult<{ blobSha: string }>>;
  findPr(repo: RepoSlug, headBranch: string): Promise<PullRequest | null>;
  /** List rows carry no `behind` or `mergeableState`; read one with `getPr` for those. */
  listOpenPrs(repo: RepoSlug, headPrefix?: string): Promise<PullRequest[]>;
  /** A conditional `listOpenPrs`: pass the `etag` of the last read, null for none. A poller that answers 304 costs no rate-limit point. */
  revalidateOpenPrs(repo: RepoSlug, etag: string | null): Promise<OpenPrList>;
  openPr(repo: RepoSlug, request: OpenPrRequest): Promise<WriteResult<{ pr: PullRequest }>>;
  getPr(repo: RepoSlug, number: number): Promise<PullRequest>;
  /** Read from the branch's active rulesets, never hardcoded. */
  requiredChecks(repo: RepoSlug, branch: string): Promise<RequiredChecks>;
  /** True when the caller can bypass every pull_request rule on the branch that requires review, or none does; a read that fails throws. A rule that requires no review cannot be the block, so it is skipped. */
  reviewRulesBypassable(repo: RepoSlug, branch: string): Promise<boolean>;
  /** Every run on `sha` from every app, superseded ones included; `mergeReadiness` needs this list. */
  checkRuns(repo: RepoSlug, sha: string): Promise<CheckRun[]>;
  /** The latest run for each check name on `sha`. */
  latestCheckRuns(repo: RepoSlug, sha: string): Promise<CheckRun[]>;
  /** Posts a completed check run under the App identity the wire was configured with; `conclusion` outside success, failure and action_required throws `GitHubInputError` before any call. */
  createCheckRun(repo: RepoSlug, request: CreateCheckRunRequest): Promise<{ id: number }>;
  getCommit(repo: RepoSlug, sha: string): Promise<Commit>;
  /** The last `lines` lines of an Actions job's log. */
  jobLogTail(repo: RepoSlug, jobId: number, lines: number): Promise<string>;
  updateBranch(repo: RepoSlug, number: number, expectedHeadSha: string): Promise<WriteResult>;
  /** Pushes a commit with the head's own tree onto `branch`, so CI runs again; skips as `head-moved` when the branch is not at `expectedHeadSha`. */
  pushEmptyCommit(repo: RepoSlug, branch: string, expectedHeadSha: string, message: string): Promise<WriteResult<{ sha: string }>>;
  merge(repo: RepoSlug, number: number, sha: string, method: MergeMethod): Promise<WriteResult<{ mergeSha: string }>>;
  rerunFailed(repo: RepoSlug, runId: number): Promise<WriteResult>;
  /** Every changed file of the PR, all pages; `previousPath` is set on a rename. Throws `FileListTruncatedError` rather than return a short list. */
  listPrFiles(repo: RepoSlug, number: number): Promise<PrFile[]>;
  /** The PR's commit shas, oldest first. GitHub stops at the first 250, so a list whose last sha is not the head is short. */
  listPrCommits(repo: RepoSlug, number: number): Promise<string[]>;
  /** The merge base of `base` and `head`, and the paths changed since it; check `truncated` before trusting the list. */
  compareFiles(repo: RepoSlug, base: string, head: string): Promise<CompareResult>;
  /**
   * Lists the PR's comments first; a comment by the authenticated user with `marker` on a line of its own skips as
   * `exists`. The body should carry the marker. Two concurrent callers can both post; there is no lock.
   */
  upsertComment(repo: RepoSlug, number: number, marker: string, body: string): Promise<WriteResult<{ id: number }>>;
  /** Every inline review comment on the PR, resolved ones included; filter on `resolved`. */
  listReviewComments(repo: RepoSlug, number: number): Promise<ReviewComment[]>;
}

/** A write whose precondition no longer holds, such as a blob that changed under an edit. */
export class GitHubConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConflictError";
  }
}

export interface GitHubPortOptions {
  /**
   * The login `upsertComment` owns comments as, for example `my-app[bot]`. Set it under a GitHub App installation
   * token: `GET /user` answers 403 there, and `GET /app` needs an App JWT the installation token is not.
   */
  login?: string;
}

/** Every argument is validated before any wire call, because each one becomes part of a `gh api` path. */
export function githubPort(wire: GitHubWire, options: GitHubPortOptions = {}): GitHubPort {
  const repoOf = checkRepo;
  const pr = (number: number) => checkPositiveInt("pr", number);
  const login = options.login === undefined ? memoizedLogin(wire) : async () => options.login!;
  return {
    getHeadSha: async (repo, branch) => wire.getRef(repoOf(repo), checkRef("branch", branch)),
    ensureBranch: async (repo, branch, baseSha) => ensureBranch(wire, repoOf(repo), checkRef("branch", branch), checkSha("baseSha", baseSha)),
    deleteRef: async (repo, head) => deleteRef(wire, repoOf(repo), { branch: checkRef("branch", head.branch), repo: head.repo }),
    getFile: async (repo, path, ref) => wire.getContent(repoOf(repo), checkPath(path), checkRef("ref", ref)),
    putFile: async (repo, request) => putFile(wire, repoOf(repo), checkPutFile(request)),
    findPr: async (repo, headBranch) => findPr(wire, repoOf(repo), checkRef("head", headBranch)),
    listOpenPrs: async (repo, headPrefix = "") => (await wire.listOpenPrs(repoOf(repo))).filter((open) => open.headRef.startsWith(headPrefix)),
    revalidateOpenPrs: async (repo, etag) => wire.revalidateOpenPrs(repoOf(repo), etag),
    openPr: async (repo, request) => openPr(wire, repoOf(repo), { ...request, head: checkRef("head", request.head), base: checkRef("base", request.base) }),
    getPr: async (repo, number) => wire.getPr(repoOf(repo), pr(number)),
    requiredChecks: async (repo, branch) => wire.getBranchRules(repoOf(repo), checkRef("branch", branch)),
    reviewRulesBypassable: async (repo, branch) => wire.reviewRulesBypassable(repoOf(repo), checkRef("branch", branch)),
    checkRuns: async (repo, sha) => wire.listCheckRuns(repoOf(repo), checkSha("sha", sha)),
    latestCheckRuns: async (repo, sha) => latestPerName(await wire.listCheckRuns(repoOf(repo), checkSha("sha", sha))),
    createCheckRun: async (repo, request) => wire.createCheckRun(repoOf(repo), { ...request, headSha: checkSha("headSha", request.headSha), conclusion: checkConclusion(request.conclusion) }),
    getCommit: async (repo, sha) => wire.getCommit(repoOf(repo), checkSha("sha", sha)),
    jobLogTail: async (repo, jobId, lines) => tail(await wire.getJobLog(repoOf(repo), checkPositiveInt("jobId", jobId)), checkPositiveInt("lines", lines)),
    updateBranch: async (repo, number, expectedHeadSha) => updateBranch(wire, repoOf(repo), pr(number), checkSha("expectedHeadSha", expectedHeadSha)),
    pushEmptyCommit: async (repo, branch, expectedHeadSha, message) => pushEmptyCommit(wire, repoOf(repo), checkRef("branch", branch), checkSha("expectedHeadSha", expectedHeadSha), message),
    merge: async (repo, number, sha, method) => merge(wire, repoOf(repo), pr(number), checkSha("sha", sha), checkMergeMethod(method)),
    rerunFailed: async (repo, runId) => rerunFailed(wire, repoOf(repo), checkPositiveInt("runId", runId)),
    listPrFiles: async (repo, number) => listPrFiles(wire, repoOf(repo), pr(number)),
    listPrCommits: async (repo, number) => wire.listPrCommits(repoOf(repo), pr(number)),
    compareFiles: async (repo, base, head) => wire.compareFiles(repoOf(repo), checkRef("base", base), checkRef("head", head)),
    upsertComment: async (repo, number, marker, body) => upsertComment(wire, login, repoOf(repo), pr(number), checkMarker(marker), body),
    listReviewComments: async (repo, number) => wire.listReviewComments(repoOf(repo), pr(number)),
  };
}

function checkPutFile(request: PutFileRequest): PutFileRequest {
  checkPath(request.path);
  checkRef("branch", request.branch);
  if (request.expectedBlobSha !== null) checkSha("expectedBlobSha", request.expectedBlobSha);
  return request;
}

async function ensureBranch(wire: GitHubWire, repo: RepoSlug, branch: string, baseSha: string): Promise<WriteResult<{ sha: string }>> {
  const existing = await wire.getRef(repo, branch);
  if (existing) return { sha: existing, done: false, skipped: "exists" };
  await wire.createRef(repo, branch, baseSha);
  return { sha: baseSha, done: true };
}

async function deleteRef(wire: GitHubWire, repo: RepoSlug, head: HeadRef): Promise<WriteResult> {
  if (head.repo === null || head.repo.toLowerCase() !== repo.toLowerCase()) return { done: false, skipped: "fork-head" };
  if (head.branch === (await wire.getDefaultBranch(repo))) return { done: false, skipped: "default-branch" };
  if ((await wire.getRef(repo, head.branch)) === null) return { done: false, skipped: "absent" };
  await wire.deleteRef(repo, head.branch);
  return { done: true };
}

function tail(log: string, lines: number): string {
  const all = log.split(/\r?\n/);
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines).join("\n");
}

async function putFile(wire: GitHubWire, repo: RepoSlug, request: PutFileRequest): Promise<WriteResult<{ blobSha: string }>> {
  const current = await wire.getContent(repo, request.path, request.branch);
  if (current && current.content === request.content) return { blobSha: current.blobSha, done: false, skipped: "unchanged" };
  const currentSha = current?.blobSha ?? null;
  if (currentSha !== request.expectedBlobSha) {
    throw new GitHubConflictError(`${request.path} on ${request.branch} is blob ${currentSha ?? "absent"}, expected ${request.expectedBlobSha ?? "absent"}`);
  }
  const written = await wire.putContent(repo, request);
  return { blobSha: written.blobSha, done: true };
}

/** An open PR wins; otherwise the newest closed one, so a crash after a merge still finds its PR. */
async function findPr(wire: GitHubWire, repo: RepoSlug, headBranch: string): Promise<PullRequest | null> {
  const prs = await wire.listPrs(repo, headBranch);
  const newestFirst = [...prs].sort((a, b) => b.number - a.number);
  return newestFirst.find((pr) => pr.state === "open") ?? newestFirst[0] ?? null;
}

async function openPr(wire: GitHubWire, repo: RepoSlug, request: OpenPrRequest): Promise<WriteResult<{ pr: PullRequest }>> {
  const existing = await findPr(wire, repo, request.head);
  if (existing) return { pr: existing, done: false, skipped: "exists" };
  return { pr: await wire.createPr(repo, request), done: true };
}

async function updateBranch(wire: GitHubWire, repo: RepoSlug, number: number, expectedHeadSha: string): Promise<WriteResult> {
  const pr = await wire.getPr(repo, number);
  const skipped = closedSkip(pr) ?? (pr.headSha !== expectedHeadSha ? "head-moved" : !pr.behind ? "up-to-date" : undefined);
  if (skipped) return { done: false, skipped };
  await wire.updateBranch(repo, number, expectedHeadSha);
  return { done: true };
}

async function pushEmptyCommit(wire: GitHubWire, repo: RepoSlug, branch: string, expectedHeadSha: string, message: string): Promise<WriteResult<{ sha: string }>> {
  const head = await wire.getRef(repo, branch);
  if (head !== expectedHeadSha) return { sha: head ?? "", done: false, skipped: head === null ? "absent" : "head-moved" };
  const { tree } = await wire.getCommit(repo, expectedHeadSha);
  if (tree === undefined) throw new Error(`commit ${expectedHeadSha} in ${repo} reports no tree`);
  const created = await wire.createCommit(repo, { message, tree, parents: [expectedHeadSha] });
  await wire.updateRef(repo, branch, created.sha);
  return { sha: created.sha, done: true };
}

async function merge(wire: GitHubWire, repo: RepoSlug, number: number, sha: string, method: MergeMethod): Promise<WriteResult<{ mergeSha: string }>> {
  const pr = await wire.getPr(repo, number);
  if (pr.merged) return { mergeSha: pr.mergeSha ?? "", done: false, skipped: "merged" };
  if (pr.state === "closed") return { mergeSha: "", done: false, skipped: "closed" };
  if (pr.headSha !== sha) return { mergeSha: "", done: false, skipped: "head-moved" };
  const merged = await wire.merge(repo, number, sha, method);
  return { mergeSha: merged.sha, done: true };
}

async function rerunFailed(wire: GitHubWire, repo: RepoSlug, runId: number): Promise<WriteResult> {
  const status = await wire.getWorkflowRunStatus(repo, runId);
  if (status !== "completed") return { done: false, skipped: "in-progress" };
  await wire.rerunFailedJobs(repo, runId);
  return { done: true };
}

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

async function listPrFiles(wire: GitHubWire, repo: RepoSlug, number: number): Promise<PrFile[]> {
  const { files, changedFiles } = await wire.listPrFiles(repo, number);
  if (files.length < changedFiles) throw new FileListTruncatedError(changedFiles, files.length);
  return files;
}

/** Resolved once per port; a failed lookup is not remembered. */
function memoizedLogin(wire: GitHubWire): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= wire.getAuthenticatedLogin().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

const holdsMarker = (body: string, marker: string): boolean => body.split(/\r?\n/).some((line) => line.trimEnd() === marker);

async function upsertComment(wire: GitHubWire, login: () => Promise<string>, repo: RepoSlug, number: number, marker: string, body: string): Promise<WriteResult<{ id: number }>> {
  const [self, comments] = await Promise.all([login(), wire.listIssueComments(repo, number)]);
  const existing = comments.find((comment) => comment.author === self && holdsMarker(comment.body, marker));
  if (existing) return { id: existing.id, done: false, skipped: "exists" };
  return { id: (await wire.createComment(repo, number, body)).id, done: true };
}

function closedSkip(pr: PullRequest): SkipReason | undefined {
  if (pr.merged) return "merged";
  return pr.state === "closed" ? "closed" : undefined;
}
