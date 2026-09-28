import { latestPerName } from "./checks.js";

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
  /** The Actions run that owns this job, for `rerunFailed`; null for non-Actions checks. */
  workflowRunId: number | null;
  url: string;
}

export interface Commit {
  sha: string;
  parents: string[];
}

export interface PutFileRequest {
  path: string;
  branch: string;
  content: string;
  message: string;
  /** The blob this write replaces; null when the file must not exist yet. */
  expectedBlobSha: string | null;
}

export interface OpenPrRequest {
  head: string;
  base: string;
  title: string;
  body: string;
}

/**
 * One GitHub call per method, unconditional, as GitHub itself behaves. `gh-cli.ts` and the test
 * fake implement it; `githubPort` puts the check-then-act rules on top of either.
 */
export interface GitHubWire {
  getRef(repo: RepoSlug, branch: string): Promise<string | null>;
  createRef(repo: RepoSlug, branch: string, sha: string): Promise<void>;
  getContent(repo: RepoSlug, path: string, ref: string): Promise<RepoFile | null>;
  putContent(repo: RepoSlug, request: PutFileRequest): Promise<{ blobSha: string }>;
  listPrs(repo: RepoSlug, headBranch: string): Promise<PullRequest[]>;
  createPr(repo: RepoSlug, request: OpenPrRequest): Promise<PullRequest>;
  getPr(repo: RepoSlug, number: number): Promise<PullRequest>;
  getBranchRules(repo: RepoSlug, branch: string): Promise<RequiredChecks>;
  listCheckRuns(repo: RepoSlug, sha: string): Promise<CheckRun[]>;
  getCommit(repo: RepoSlug, sha: string): Promise<Commit>;
  getWorkflowRunStatus(repo: RepoSlug, runId: number): Promise<string>;
  updateBranch(repo: RepoSlug, number: number, expectedHeadSha: string): Promise<void>;
  merge(repo: RepoSlug, number: number, sha: string, method: MergeMethod): Promise<{ sha: string }>;
  rerunFailedJobs(repo: RepoSlug, runId: number): Promise<void>;
}

export type SkipReason = "exists" | "unchanged" | "merged" | "closed" | "head-moved" | "up-to-date" | "in-progress";

/** A write either happened now or was skipped because its effect is already in place (or can no longer apply). */
export type WriteResult<T = object> = T & ({ done: true } | { done: false; skipped: SkipReason });

/** Every write reads first, so repeating one after a crash is a no-op. */
export interface GitHubPort {
  getHeadSha(repo: RepoSlug, branch: string): Promise<string | null>;
  ensureBranch(repo: RepoSlug, branch: string, baseSha: string): Promise<WriteResult<{ sha: string }>>;
  getFile(repo: RepoSlug, path: string, ref: string): Promise<RepoFile | null>;
  putFile(repo: RepoSlug, request: PutFileRequest): Promise<WriteResult<{ blobSha: string }>>;
  findPr(repo: RepoSlug, headBranch: string): Promise<PullRequest | null>;
  openPr(repo: RepoSlug, request: OpenPrRequest): Promise<WriteResult<{ pr: PullRequest }>>;
  getPr(repo: RepoSlug, number: number): Promise<PullRequest>;
  /** Read from the branch's active rulesets, never hardcoded. */
  requiredChecks(repo: RepoSlug, branch: string): Promise<RequiredChecks>;
  /** The latest run for each check name on `sha`. */
  latestCheckRuns(repo: RepoSlug, sha: string): Promise<CheckRun[]>;
  getCommit(repo: RepoSlug, sha: string): Promise<Commit>;
  updateBranch(repo: RepoSlug, number: number, expectedHeadSha: string): Promise<WriteResult>;
  merge(repo: RepoSlug, number: number, sha: string, method: MergeMethod): Promise<WriteResult<{ mergeSha: string }>>;
  rerunFailed(repo: RepoSlug, runId: number): Promise<WriteResult>;
}

/** A write whose precondition no longer holds, such as a blob that changed under an edit. */
export class GitHubConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConflictError";
  }
}

export function githubPort(wire: GitHubWire): GitHubPort {
  return {
    getHeadSha: (repo, branch) => wire.getRef(repo, branch),
    ensureBranch: (repo, branch, baseSha) => ensureBranch(wire, repo, branch, baseSha),
    getFile: (repo, path, ref) => wire.getContent(repo, path, ref),
    putFile: (repo, request) => putFile(wire, repo, request),
    findPr: (repo, headBranch) => findPr(wire, repo, headBranch),
    openPr: (repo, request) => openPr(wire, repo, request),
    getPr: (repo, number) => wire.getPr(repo, number),
    requiredChecks: (repo, branch) => wire.getBranchRules(repo, branch),
    latestCheckRuns: async (repo, sha) => latestPerName(await wire.listCheckRuns(repo, sha)),
    getCommit: (repo, sha) => wire.getCommit(repo, sha),
    updateBranch: (repo, number, expectedHeadSha) => updateBranch(wire, repo, number, expectedHeadSha),
    merge: (repo, number, sha, method) => merge(wire, repo, number, sha, method),
    rerunFailed: (repo, runId) => rerunFailed(wire, repo, runId),
  };
}

async function ensureBranch(wire: GitHubWire, repo: RepoSlug, branch: string, baseSha: string): Promise<WriteResult<{ sha: string }>> {
  const existing = await wire.getRef(repo, branch);
  if (existing) return { sha: existing, done: false, skipped: "exists" };
  await wire.createRef(repo, branch, baseSha);
  return { sha: baseSha, done: true };
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

function closedSkip(pr: PullRequest): SkipReason | undefined {
  if (pr.merged) return "merged";
  return pr.state === "closed" ? "closed" : undefined;
}
