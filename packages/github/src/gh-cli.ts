import { sharedRateBudget, type RateBudget } from "./budget.js";
import { redact, redactStreams } from "./redact.js";
import { listForcePushes } from "./force-pushes.js";
import { graphql } from "./graphql.js";
import { checkRunBody } from "./check-run-create.js";
import { GhError, execGh, type GhExec } from "./exec.js";
import { COMPARE_FILE_CAP } from "./port.js";
import type { CreateCheckRunRequest } from "./check-run-create.js";
import type { CheckRun, Commit, CommitStatus, CompareResult, GitHubWire, IssueComment, PrFile, PullRequest, RepoFile } from "./port.js";
import type { SquashSource } from "./port-types.js";
import type { OpenPrList } from "./pr-list.js";
import type { ReviewComment } from "./review-comment.js";
import { restCaller, type Rest } from "./rest.js";
import { branchRules, classicRequiredChecks, type GhRule } from "./rules-read.js";

export interface GhCliOptions {
  /** Defaults to one budget per process, because GitHub counts calls per login. */
  budget?: RateBudget;
  /** Most recent conditional GETs whose ETag and body are kept. */
  etagCacheSize?: number;
  /**
   * Mints the GitHub App installation token that `createCheckRun` posts under. It is called per
   * check run, so a cached provider should refresh itself; without it `createCheckRun` refuses.
   */
  appToken?: () => Promise<string>;
  /** Waits between attempts of a failed read; tests inject one so they do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export function ghCliWire(exec: GhExec = execGh, options: GhCliOptions = {}): GitHubWire {
  const api = restCaller(exec, options.budget ?? sharedRateBudget, options.etagCacheSize ?? 500, options.sleep);
  return {
    getRef: async (repo, branch) => (await api.getOrNull<{ object: { sha: string } }>(`repos/${repo}/git/ref/heads/${branch}`))?.object.sha ?? null,
    createRef: async (repo, branch, sha) => void (await api.send("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })),
    createCommit: async (repo, request) => ({ sha: (await api.send<{ sha: string }>("POST", `repos/${repo}/git/commits`, {}, JSON.stringify(request))).sha }),
    updateRef: async (repo, branch, sha) => void (await api.send("PATCH", `repos/${repo}/git/refs/heads/${branch}`, {}, JSON.stringify({ sha, force: false }))),
    deleteRef: async (repo, branch) => void (await api.send("DELETE", `repos/${repo}/git/refs/heads/${branch}`)),
    getDefaultBranch: async (repo) => (await api.get<{ default_branch: string }>(`repos/${repo}`)).default_branch,
    getContent: (repo, path, ref) => getContent(api, repo, path, ref),
    putContent: async (repo, request) => {
      const body = { message: request.message, content: Buffer.from(request.content, "utf8").toString("base64"), branch: request.branch, ...(request.expectedBlobSha ? { sha: request.expectedBlobSha } : {}) };
      const written = await api.send<{ content: { sha: string } }>("PUT", `repos/${repo}/contents/${request.path}`, {}, JSON.stringify(body));
      return { blobSha: written.content.sha };
    },
    listPrs: (repo, headBranch) => listPulls(api, repo, { head: `${repo.split("/")[0]}:${headBranch}`, state: "all" }),
    listOpenPrs: (repo) => listPulls(api, repo, { state: "open" }),
    revalidateOpenPrs: (repo, etag) => revalidateOpenPulls(api, repo, etag),
    createPr: async (repo, request) => toPullRequest(await api.send<GhPull>("POST", `repos/${repo}/pulls`, {}, JSON.stringify(request))),
    getPr: (repo, number) => getPr(api, repo, number),
    getBranchRules: (repo, branch) => branchRules(api, repo, branch),
    getClassicRequiredChecks: (repo, branch) => classicRequiredChecks(api, repo, branch),
    reviewRulesBypassable: (repo, branch) => reviewRulesBypassable(api, repo, branch),
    getBranchProtected: (repo, branch) => branchProtected(api, repo, branch),
    listCheckRuns: (repo, sha) => listCheckRuns(api, repo, sha),
    createCheckRun: async (repo, request) => createCheckRun(exec, options, repo, request),
    getCommit: async (repo, sha) => {
      const commit = await api.get<{ sha: string; parents: { sha: string }[]; tree?: { sha: string }; committer?: { date?: string } }>(`repos/${repo}/git/commits/${sha}`);
      const committedAt = commit.committer?.date;
      const tree = commit.tree?.sha;
      return { sha: commit.sha, parents: commit.parents.map((parent) => parent.sha), ...(tree ? { tree } : {}), ...(committedAt ? { committedAt } : {}) } satisfies Commit;
    },
    resolveCommit: (repo, sha) => resolveCommit(api, repo, sha),
    listCommitStatuses: (repo, sha) => listCommitStatuses(api, repo, sha),
    getWorkflowRunStatus: async (repo, runId) => (await api.get<{ status: string }>(`repos/${repo}/actions/runs/${runId}`)).status,
    getJobLog: (repo, jobId) => api.text(`repos/${repo}/actions/jobs/${jobId}/logs`),
    updateBranch: async (repo, number, expectedHeadSha) => void (await api.send("PUT", `repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: expectedHeadSha })),
    setPrBase: async (repo, number, base) => void (await api.send("PATCH", `repos/${repo}/pulls/${number}`, {}, JSON.stringify({ base }))),
    merge: async (repo, number, sha, method, message) => {
      const fields = { sha, merge_method: method, ...(message ? { commit_title: message.subject, commit_message: message.body } : {}) };
      return { sha: (await api.send<{ sha: string }>("PUT", `repos/${repo}/pulls/${number}/merge`, fields)).sha };
    },
    getSquashSource: (repo, number) => getSquashSource(api, repo, number),
    rerunFailedJobs: async (repo, runId) => void (await api.send("POST", `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`)),
    listPrFiles: (repo, number) => listPrFiles(api, repo, number),
    listPrCommits: (repo, number) => api.pages(`repos/${repo}/pulls/${number}/commits`, { per_page: "100" }, (page: { sha: string }[]) => page.map((commit) => commit.sha)),
    listCommits: (repo, since) => api.pages(`repos/${repo}/commits`, { since, per_page: "100" }, (page: { sha: string; commit: { message: string } }[]) => page.map((commit) => ({ sha: commit.sha, message: commit.commit.message }))),
    compareFiles: (repo, base, head) => compareFiles(api, repo, base, head),
    getAuthenticatedLogin: async () => (await api.get<{ login: string }>("user")).login,
    listIssueComments: (repo, number) => listIssueComments(api, repo, number),
    createComment: async (repo, number, body) => ({ id: (await api.send<{ id: number }>("POST", `repos/${repo}/issues/${number}/comments`, {}, JSON.stringify({ body }))).id }),
    listReviewComments: (repo, number) => listReviewComments(api, repo, number),
    listForcePushes: (repo, number) => listForcePushes(api, repo, number),
  };
}

/** The token rides in the child env of this one call; any error is rebuilt without it. */
async function createCheckRun(exec: GhExec, options: GhCliOptions, repo: string, request: CreateCheckRunRequest): Promise<{ id: number }> {
  if (!options.appToken) throw new Error("createCheckRun needs a GitHub App token provider (GhCliOptions.appToken)");
  let token = "";
  try {
    token = await options.appToken();
    const scoped: GhExec = (args, input, execOptions) => exec(args, input, { ...execOptions, env: { ...execOptions?.env, GH_TOKEN: token } });
    const api = restCaller(scoped, options.budget ?? sharedRateBudget, 0);
    return { id: (await api.send<{ id: number }>("POST", `repos/${repo}/check-runs`, {}, checkRunBody(request))).id };
  } catch (error) {
    throw redactedError(error, [token]);
  }
}

/** Keeps `GhError.status` so callers can still branch on the HTTP status. */
function redactedError(error: unknown, secrets: readonly string[]): Error {
  if (error instanceof GhError) {
    const { code, stdout, stderr } = error.result;
    const [cleanOut, cleanErr] = redactStreams(stdout, stderr, secrets);
    return new GhError(error.args, { code, stdout: cleanOut, stderr: cleanErr }, error.status);
  }
  return new Error(redact(error instanceof Error ? error.message : String(error), secrets));
}

async function getContent(api: Rest, repo: string, path: string, ref: string): Promise<RepoFile | null> {
  const file = await api.getOrNull<{ path: string; sha: string; content: string; encoding: string }>(`repos/${repo}/contents/${path}`, { ref });
  if (!file) return null;
  if (file.encoding !== "base64") throw new Error(`${path} is ${file.encoding}-encoded; only files GitHub returns inline are supported`);
  return { path: file.path, blobSha: file.sha, content: Buffer.from(file.content, "base64").toString("utf8") };
}

interface GhPull {
  number: number;
  state: unknown;
  title?: string;
  body?: string | null;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha: string | null;
  draft?: boolean;
  mergeable_state?: string;
  auto_merge?: object | null;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string };
}

/** A state the shepherd cannot place must fail the read: a caller that treats "not open" as closed would release on it. */
function pullState(pr: GhPull): PullRequest["state"] {
  if (pr.state === "open" || pr.state === "closed") return pr.state;
  throw new Error(`the pull request answered state ${JSON.stringify(pr.state)}, neither open nor closed`);
}

function toPullRequest(pr: GhPull, behindBy?: number): PullRequest {
  return {
    number: pr.number,
    state: pullState(pr),
    merged: pr.merged ?? Boolean(pr.merged_at),
    mergeSha: pr.merge_commit_sha,
    mergedAt: pr.merged_at ?? null,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepo: pr.head.repo?.full_name ?? null,
    baseRef: pr.base.ref,
    draft: pr.draft ?? false,
    mergeableState: pr.mergeable_state ?? "unknown",
    behind: (behindBy ?? 0) > 0,
    ...(behindBy === undefined ? {} : { behindBy }),
    autoMerge: pr.auto_merge != null,
    ...(pr.title === undefined ? {} : { title: pr.title, body: pr.body ?? "" }),
  };
}

async function getSquashSource(api: Rest, repo: string, number: number): Promise<SquashSource> {
  const [pr, commits] = await Promise.all([
    api.get<{ title: string; body: string | null }>(`repos/${repo}/pulls/${number}`),
    api.pages(`repos/${repo}/pulls/${number}/commits`, { per_page: "100" }, (page: { commit: { message: string } }[]) => page.map((commit) => splitMessage(commit.commit.message))),
  ]);
  return { title: pr.title, body: pr.body ?? "", commits };
}

function splitMessage(message: string): SquashSource["commits"][number] {
  const [subject = "", ...rest] = message.split("\n");
  return { subject, body: rest.join("\n").trim() };
}

async function listPulls(api: Rest, repo: string, fields: Record<string, string>): Promise<PullRequest[]> {
  const prs = await api.pages(`repos/${repo}/pulls`, { ...fields, per_page: "100" }, (page: GhPull[]) => page);
  return prs.map((pr) => toPullRequest(pr));
}

async function revalidateOpenPulls(api: Rest, repo: string, etag: string | null): Promise<OpenPrList> {
  const read = await api.revalidatePages(`repos/${repo}/pulls`, { state: "open", per_page: "100" }, etag, (page: GhPull[]) => page);
  return read.notModified ? read : { notModified: false, prs: read.body.map((pr) => toPullRequest(pr)), etag: read.etag };
}

/** `behind` comes from the compare API, which is exact, not from the lazily computed `mergeable_state`. */
async function getPr(api: Rest, repo: string, number: number): Promise<PullRequest> {
  const pr = await api.get<GhPull>(`repos/${repo}/pulls/${number}`);
  if (pr.state !== "open") return toPullRequest(pr, 0);
  const compare = await api.get<{ behind_by: number }>(`repos/${repo}/compare/${pr.base.ref}...${pr.head.sha}`, { per_page: "1" });
  return toPullRequest(pr, compare.behind_by);
}

async function branchProtected(api: Rest, repo: string, branch: string): Promise<boolean> {
  const body = await api.get<{ protected?: unknown }>(`repos/${repo}/branches/${branch}`);
  if (typeof body?.protected !== "boolean") throw new Error("the branch answered no boolean protected flag, so whether it is protected is unknown");
  return body.protected;
}

function requiresReview(rule: GhRule): boolean {
  const p = rule.parameters ?? {};
  return (p.required_approving_review_count ?? 0) > 0 || p.require_code_owner_review === true || p.required_review_thread_resolution === true || (p.required_reviewers?.length ?? 0) > 0;
}

const BYPASS_OK = new Set(["always", "pull_requests_only"]);

async function reviewRulesBypassable(api: Rest, repo: string, branch: string): Promise<boolean> {
  const rules = await api.get<GhRule[]>(`repos/${repo}/rules/branches/${branch}`);
  const ids = new Set(rules.filter((rule) => rule.type === "pull_request" && requiresReview(rule)).map((rule) => rule.ruleset_id));
  for (const id of ids) {
    const ruleset = await api.get<{ current_user_can_bypass?: string }>(`repos/${repo}/rulesets/${id}`);
    if (!BYPASS_OK.has(ruleset.current_user_can_bypass ?? "")) return false;
  }
  return true;
}

interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  head_sha: string;
  details_url: string | null;
  html_url: string | null;
  app?: { id: number } | null;
  pull_requests?: { number: number; base: { ref: string } }[];
}

async function listCheckRuns(api: Rest, repo: string, sha: string): Promise<CheckRun[]> {
  const runs = await api.pages(`repos/${repo}/commits/${sha}/check-runs`, { per_page: "100" }, (page: { check_runs: GhCheckRun[] }) => page.check_runs);
  return runs.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.started_at,
    headSha: run.head_sha,
    appId: run.app?.id ?? null,
    workflowRunId: workflowRunIdOf(run.details_url ?? run.html_url),
    pullRequests: (run.pull_requests ?? []).map((pr) => ({ number: pr.number, baseRef: pr.base.ref })),
    url: run.html_url ?? run.details_url ?? "",
  }));
}

/** `commits/{ref}` expands an abbreviation, unlike `git/commits/{sha}`; GitHub answers 422 "No commit found" for a sha it lacks. */
async function resolveCommit(api: Rest, repo: string, sha: string): Promise<string | null> {
  try {
    return (await api.get<{ sha: string }>(`repos/${repo}/commits/${sha}`)).sha;
  } catch (error) {
    if (error instanceof GhError && (error.status === 422 || error.status === 404)) return null;
    throw error;
  }
}

/** A list shorter than `total_count` throws rather than read as complete, because a missing failure would read as green. */
async function listCommitStatuses(api: Rest, repo: string, sha: string): Promise<CommitStatus[]> {
  let total = 0;
  const statuses = await api.pages(`repos/${repo}/commits/${sha}/status`, { per_page: "100" }, (page: { total_count: number; statuses: CommitStatus[] }) => {
    total = page.total_count;
    return page.statuses;
  });
  if (statuses.length !== total) throw new Error(`the combined status of ${sha} listed ${statuses.length} of ${total} statuses`);
  return statuses.map((status) => ({ context: status.context, state: status.state }));
}

/** Actions job URLs read `.../actions/runs/<runId>/job/<jobId>`. */
function workflowRunIdOf(url: string | null): number | null {
  const match = url ? /\/actions\/runs\/(\d+)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

interface GhPrFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions?: number;
  deletions?: number;
}

/** The count comes from the PR itself; a missing one throws, because the port cannot then tell a capped list. */
async function listPrFiles(api: Rest, repo: string, number: number): Promise<{ files: PrFile[]; changedFiles: number }> {
  const { changed_files: changedFiles } = await api.get<{ changed_files?: number }>(`repos/${repo}/pulls/${number}`);
  if (typeof changedFiles !== "number") throw new Error(`pull ${number} on ${repo} reported no changed_files count`);
  const listed = await api.pages(`repos/${repo}/pulls/${number}/files`, { per_page: "100" }, (page: GhPrFile[]) => page);
  return { changedFiles, files: listed.map(prFileOf) };
}

function prFileOf(file: GhPrFile): PrFile {
  const counted = typeof file.additions === "number" && typeof file.deletions === "number";
  return { path: file.filename, ...(file.previous_filename ? { previousPath: file.previous_filename } : {}), status: file.status, ...(counted && { additions: file.additions, deletions: file.deletions }) };
}

async function listIssueComments(api: Rest, repo: string, number: number): Promise<IssueComment[]> {
  const comments = await api.pages(`repos/${repo}/issues/${number}/comments`, { per_page: "100" }, (page: { id: number; body: string; user: { login: string } | null }[]) => page);
  return comments.map((comment) => ({ id: comment.id, body: comment.body, author: comment.user?.login ?? "" }));
}

const COMMENT_FIELDS = "pageInfo { hasNextPage endCursor } nodes { databaseId body path line authorAssociation author { login } }";

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 100) { ${COMMENT_FIELDS} } }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { ${COMMENT_FIELDS} } } }
}`;

interface GhPage<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

interface GhReviewComment {
  databaseId: number;
  body: string;
  path: string;
  line: number | null;
  authorAssociation: string;
  author: { login: string } | null;
}

interface GhReviewThread {
  id: string;
  isResolved: boolean;
  comments: GhPage<GhReviewComment>;
}

/** Only GraphQL review threads carry the resolved state; REST review comments do not. */
async function listReviewComments(api: Rest, repo: string, number: number): Promise<ReviewComment[]> {
  const [owner, name] = repo.split("/");
  const comments: ReviewComment[] = [];
  for (let cursor: string | null = null, more = true; more; ) {
    const threads: GhPage<GhReviewThread> = await graphql(api, `review threads of ${repo}#${number}`, REVIEW_THREADS_QUERY, { owner, name, number, cursor }, (data: { repository?: { pullRequest?: { reviewThreads: GhPage<GhReviewThread> } | null } | null }) => data.repository?.pullRequest?.reviewThreads);
    for (const thread of threads.nodes) comments.push(...(await threadComments(api, thread)));
    ({ hasNextPage: more, endCursor: cursor } = threads.pageInfo);
  }
  return comments;
}

/** A thread past its first 100 comments is read on by its node id. */
async function threadComments(api: Rest, thread: GhReviewThread): Promise<ReviewComment[]> {
  const nodes = [...thread.comments.nodes];
  for (let page = thread.comments.pageInfo; page.hasNextPage; ) {
    const next: GhPage<GhReviewComment> = await graphql(api, `review thread ${thread.id}`, THREAD_COMMENTS_QUERY, { id: thread.id, cursor: page.endCursor }, (data: { node?: { comments?: GhPage<GhReviewComment> } | null }) => data.node?.comments);
    nodes.push(...next.nodes);
    page = next.pageInfo;
  }
  return nodes.map((comment) => ({ id: comment.databaseId, author: comment.author?.login ?? "", authorAssociation: comment.authorAssociation, path: comment.path, line: comment.line, body: comment.body, resolved: thread.isResolved }));
}

interface GhComparePage {
  merge_base_commit: { sha: string };
  total_commits?: number;
  commits?: unknown[];
  files?: { filename: string }[];
}

/** Every page repeats the merge base and total; files and commits are split across pages. */
async function compareFiles(api: Rest, repo: string, base: string, head: string): Promise<CompareResult> {
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
