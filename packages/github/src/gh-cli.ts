import { sharedRateBudget, type RateBudget } from "./budget.js";
import { execGh, type GhExec } from "./exec.js";
import { COMPARE_FILE_CAP } from "./port.js";
import type { CheckRun, Commit, CompareResult, GitHubWire, IssueComment, PrFile, PullRequest, RepoFile, RequiredChecks } from "./port.js";
import { restCaller, type Rest } from "./rest.js";

export interface GhCliOptions {
  /** Defaults to one budget per process, because GitHub counts calls per login. */
  budget?: RateBudget;
  /** Most recent conditional GETs whose ETag and body are kept. */
  etagCacheSize?: number;
}

export function ghCliWire(exec: GhExec = execGh, options: GhCliOptions = {}): GitHubWire {
  const api = restCaller(exec, options.budget ?? sharedRateBudget, options.etagCacheSize ?? 500);
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
    createPr: async (repo, request) => toPullRequest(await api.send<GhPull>("POST", `repos/${repo}/pulls`, {}, JSON.stringify(request)), false),
    getPr: (repo, number) => getPr(api, repo, number),
    getBranchRules: async (repo, branch) => requiredChecksFrom(await api.get<GhRule[]>(`repos/${repo}/rules/branches/${branch}`)),
    reviewRulesBypassable: (repo, branch) => reviewRulesBypassable(api, repo, branch),
    listCheckRuns: (repo, sha) => listCheckRuns(api, repo, sha),
    getCommit: async (repo, sha) => {
      const commit = await api.get<{ sha: string; parents: { sha: string }[]; tree?: { sha: string }; committer?: { date?: string } }>(`repos/${repo}/git/commits/${sha}`);
      const committedAt = commit.committer?.date;
      const tree = commit.tree?.sha;
      return { sha: commit.sha, parents: commit.parents.map((parent) => parent.sha), ...(tree ? { tree } : {}), ...(committedAt ? { committedAt } : {}) } satisfies Commit;
    },
    getWorkflowRunStatus: async (repo, runId) => (await api.get<{ status: string }>(`repos/${repo}/actions/runs/${runId}`)).status,
    getJobLog: (repo, jobId) => api.text(`repos/${repo}/actions/jobs/${jobId}/logs`),
    updateBranch: async (repo, number, expectedHeadSha) => void (await api.send("PUT", `repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: expectedHeadSha })),
    merge: async (repo, number, sha, method) => ({ sha: (await api.send<{ sha: string }>("PUT", `repos/${repo}/pulls/${number}/merge`, { sha, merge_method: method })).sha }),
    rerunFailedJobs: async (repo, runId) => void (await api.send("POST", `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`)),
    listPrFiles: (repo, number) => listPrFiles(api, repo, number),
    compareFiles: (repo, base, head) => compareFiles(api, repo, base, head),
    getAuthenticatedLogin: async () => (await api.get<{ login: string }>("user")).login,
    listIssueComments: (repo, number) => listIssueComments(api, repo, number),
    createComment: async (repo, number, body) => ({ id: (await api.send<{ id: number }>("POST", `repos/${repo}/issues/${number}/comments`, {}, JSON.stringify({ body }))).id }),
  };
}

async function getContent(api: Rest, repo: string, path: string, ref: string): Promise<RepoFile | null> {
  const file = await api.getOrNull<{ path: string; sha: string; content: string; encoding: string }>(`repos/${repo}/contents/${path}`, { ref });
  if (!file) return null;
  if (file.encoding !== "base64") throw new Error(`${path} is ${file.encoding}-encoded; only files GitHub returns inline are supported`);
  return { path: file.path, blobSha: file.sha, content: Buffer.from(file.content, "base64").toString("utf8") };
}

interface GhPull {
  number: number;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha: string | null;
  draft?: boolean;
  mergeable_state?: string;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string };
}

function toPullRequest(pr: GhPull, behind: boolean): PullRequest {
  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged ?? Boolean(pr.merged_at),
    mergeSha: pr.merge_commit_sha,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepo: pr.head.repo?.full_name ?? null,
    baseRef: pr.base.ref,
    draft: pr.draft ?? false,
    mergeableState: pr.mergeable_state ?? "unknown",
    behind,
  };
}

async function listPulls(api: Rest, repo: string, fields: Record<string, string>): Promise<PullRequest[]> {
  const prs = await api.pages(`repos/${repo}/pulls`, { ...fields, per_page: "100" }, (page: GhPull[]) => page);
  return prs.map((pr) => toPullRequest(pr, false));
}

/** `behind` comes from the compare API, which is exact, not from the lazily computed `mergeable_state`. */
async function getPr(api: Rest, repo: string, number: number): Promise<PullRequest> {
  const pr = await api.get<GhPull>(`repos/${repo}/pulls/${number}`);
  if (pr.state !== "open") return toPullRequest(pr, false);
  const compare = await api.get<{ behind_by: number }>(`repos/${repo}/compare/${pr.base.ref}...${pr.head.sha}`, { per_page: "1" });
  return toPullRequest(pr, compare.behind_by > 0);
}

interface GhRule {
  type: string;
  ruleset_id?: number;
  parameters?: { required_approving_review_count?: number; require_code_owner_review?: boolean; required_review_thread_resolution?: boolean; required_reviewers?: unknown[]; strict_required_status_checks_policy?: boolean; required_status_checks?: { context: string }[] };
}

function requiredChecksFrom(rules: readonly GhRule[]): RequiredChecks {
  const statusRules = rules.filter((rule) => rule.type === "required_status_checks");
  const contexts = new Set(statusRules.flatMap((rule) => rule.parameters?.required_status_checks?.map((check) => check.context) ?? []));
  return { contexts: [...contexts].sort(), strict: statusRules.some((rule) => rule.parameters?.strict_required_status_checks_policy === true) };
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
    url: run.html_url ?? run.details_url ?? "",
  }));
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
}

/** The count comes from the PR itself; a missing one throws, because the port cannot then tell a capped list. */
async function listPrFiles(api: Rest, repo: string, number: number): Promise<{ files: PrFile[]; changedFiles: number }> {
  const { changed_files: changedFiles } = await api.get<{ changed_files?: number }>(`repos/${repo}/pulls/${number}`);
  if (typeof changedFiles !== "number") throw new Error(`pull ${number} on ${repo} reported no changed_files count`);
  const listed = await api.pages(`repos/${repo}/pulls/${number}/files`, { per_page: "100" }, (page: GhPrFile[]) => page);
  return { changedFiles, files: listed.map((file) => ({ path: file.filename, ...(file.previous_filename ? { previousPath: file.previous_filename } : {}), status: file.status })) };
}

async function listIssueComments(api: Rest, repo: string, number: number): Promise<IssueComment[]> {
  const comments = await api.pages(`repos/${repo}/issues/${number}/comments`, { per_page: "100" }, (page: { id: number; body: string; user: { login: string } | null }[]) => page);
  return comments.map((comment) => ({ id: comment.id, body: comment.body, author: comment.user?.login ?? "" }));
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
