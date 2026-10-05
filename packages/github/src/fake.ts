import { createHash } from "node:crypto";
import { GITHUB_ACTIONS_APP_ID } from "./readiness.js";
import { COMPARE_COMMIT_CAP, COMPARE_FILE_CAP, PR_FILES_CAP } from "./port.js";
import type { CreateCheckRunRequest } from "./check-run-create.js";
import type { ReviewComment } from "./review-comment.js";
import type { CheckRun, Commit, IssueComment, PrFile, GitHubWire, MergeMethod, OpenPrList, OpenPrRequest, PullRequest, PutFileRequest, RequiredChecks } from "./port.js";

/** Counts of calls that change GitHub; a crash test asserts each is at most one. */
export interface FakeEffects {
  createRef: number;
  deleteRef: number;
  putContent: number;
  createPr: number;
  updateBranch: number;
  updateRef: number;
  merge: number;
  rerunFailedJobs: number;
}

export interface FakeGitHub {
  wire: GitHubWire;
  effects: FakeEffects;
  /** Every wire call in order, as `method` names; lets a test prove what was never called. */
  calls: string[];
  /** Calls in `calls` that answered 304: each is still a request, but GitHub charges it no rate-limit point. */
  notModified: number;
  rules: RequiredChecks;
  /** What `reviewRulesBypassable` answers; false like a repo whose approval rule the caller cannot bypass. */
  reviewBypass: boolean;
  addPr(fields: Partial<PullRequest> & { headSha: string }): PullRequest;
  /** The live record, so a test can move the world (behind, mergeable_state) between steps. */
  pr(number: number): PullRequest;
  /** Stored as given, except a run with no `headSha` is stamped with `sha`; picking the latest run per name is the port's job. */
  setRuns(sha: string, runs: CheckRun[]): void;
  /** A foreign push: moves the PR head without this run doing it. */
  pushHead(number: number, sha: string): void;
  /** When set, update-branch answers HTTP 422 "merge conflict between base and head", as GitHub does when the base cannot merge in. */
  updateBranchConflict?: boolean;
  /** Called at the start of every `getPr`, so a test can move the world between polls. */
  onGetPr?: (pr: PullRequest, reads: number) => void;
  /** Every check run created, with the title, summary and external id that `CheckRun` does not carry. */
  createdCheckRuns: { id: number; repo: string; request: CreateCheckRunRequest }[];
  commits: Map<string, Commit>;
  refs: Map<string, string>;
  /** Job id to full log text, for `getJobLog`. */
  jobLogs: Map<number, string>;
  files: Map<string, { content: string; blobSha: string }>;
  /** The login `createComment` posts as and `getAuthenticatedLogin` answers with. */
  actor: string;
  /** PR number to its changed files. `listPrFiles` returns at most 3,000 of them, like GitHub. */
  prFiles: Map<number, PrFile[]>;
  /** PR number to the PR's own `changed_files` count; unset means the length of `prFiles`. */
  prChangedFiles: Map<number, number>;
  /** `base...head` to the compare inputs; an unset pair compares as no change. Caps of 300 files and 250 commits apply. */
  compares: Map<string, { mergeBaseSha: string; files: string[]; totalCommits?: number }>;
  /** PR number to its issue comments, in posting order. */
  comments: Map<number, IssueComment[]>;
  /** PR number to its inline review comments, resolved or not. */
  reviewComments: Map<number, ReviewComment[]>;
}

export class FakeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}

/** A real-shaped commit sha, stable per tag, so tests can name heads. */
export function fakeSha(tag: string): string {
  return createHash("sha1").update(tag).digest("hex");
}

export function successRun(name: string, id: number, startedAt = "2026-01-01T00:00:00Z", conclusion = "success", appId = GITHUB_ACTIONS_APP_ID, headSha = ""): CheckRun {
  return { id, name, status: "completed", conclusion, startedAt, headSha, appId, workflowRunId: 1000 + id, url: `https://example.test/actions/runs/${1000 + id}/job/${id}` };
}

/** The App id the fake posts check runs as unless `fakeGitHub({ appId })` says otherwise. */
export const FAKE_APP_ID = 424242;

/** An in-memory GitHub: one repo slug per key, strict rules, and unconditional writes like the real API. */
export function fakeGitHub(options: { base?: string; baseSha?: string; repo?: string; appId?: number } = {}): FakeGitHub {
  const base = options.base ?? "main";
  const repo = options.repo ?? "o/r";
  let counter = 0;
  const nextSha = (tag: string): string => fakeSha(`${tag}${++counter}`);
  const effects: FakeEffects = { createRef: 0, deleteRef: 0, putContent: 0, createPr: 0, updateBranch: 0, updateRef: 0, merge: 0, rerunFailedJobs: 0 };
  const prs = new Map<number, PullRequest>();
  const runs = new Map<string, CheckRun[]>();
  const runStatus = new Map<number, string>();
  const reads = new Map<number, number>();
  const fake: FakeGitHub = {
    effects,
    calls: [],
    notModified: 0,
    rules: { contexts: ["validate", "dag-check"], strict: true },
    reviewBypass: false,
    createdCheckRuns: [],
    commits: new Map(),
    refs: new Map([[base, options.baseSha ?? fakeSha("base")]]),
    jobLogs: new Map(),
    files: new Map(),
    actor: "shepherd-bot",
    prFiles: new Map(),
    prChangedFiles: new Map(),
    compares: new Map(),
    comments: new Map(),
    reviewComments: new Map(),
    addPr(fields) {
      const pr: PullRequest = { number: prs.size + 1, state: "open", merged: false, mergeSha: null, headRef: `topic-${prs.size + 1}`, headRepo: repo, baseRef: base, draft: false, mergeableState: "clean", behind: false, ...fields };
      prs.set(pr.number, pr);
      return { ...pr };
    },
    pr: (number) => mustPr(prs, number),
    setRuns: (sha, list) => runs.set(sha, list.map((run) => ({ ...run, headSha: run.headSha || sha }))),
    pushHead: (number, sha) => {
      mustPr(prs, number).headSha = sha;
    },
  } as Omit<FakeGitHub, "wire"> as FakeGitHub;
  const record = <T>(name: string, value: T): T => (fake.calls.push(name), value);
  fake.wire = {
    getRef: async (_repo, branch) => record("getRef", fake.refs.get(branch) ?? null),
    createRef: async (_repo, branch, sha) => {
      record("createRef", undefined);
      if (fake.refs.has(branch)) throw new FakeHttpError(422, "Reference already exists");
      effects.createRef += 1;
      fake.refs.set(branch, sha);
    },
    createCommit: async (_repo, request) => {
      const sha = nextSha("commit");
      fake.commits.set(sha, { sha, parents: [...request.parents], tree: request.tree });
      return record("createCommit", { sha });
    },
    updateRef: async (_repo, branch, sha) => record("updateRef", updateRef(fake, prs, branch, sha)),
    deleteRef: async (_repo, branch) => {
      record("deleteRef", undefined);
      if (!fake.refs.delete(branch)) throw new FakeHttpError(422, "Reference does not exist");
      effects.deleteRef += 1;
    },
    getDefaultBranch: async () => record("getDefaultBranch", base),
    getContent: async (_repo, path, ref) => {
      const file = fake.files.get(`${ref}:${path}`);
      return record("getContent", file ? { path, blobSha: file.blobSha, content: file.content } : null);
    },
    putContent: async (_repo, request) => record("putContent", putContent(fake, request, nextSha)),
    listPrs: async (_repo, headBranch) => record("listPrs", [...prs.values()].filter((pr) => pr.headRef === headBranch).map((pr) => ({ ...pr }))),
    listOpenPrs: async () => record("listOpenPrs", [...prs.values()].filter((pr) => pr.state === "open").map((pr) => ({ ...pr }))),
    revalidateOpenPrs: async (_repo, etag) => record("revalidateOpenPrs", revalidateOpenPrs(fake, prs, etag)),
    createPr: async (_repo, request) => record("createPr", createPr(fake, request)),
    getPr: async (_repo, number) => {
      const pr = mustPr(prs, number);
      reads.set(number, (reads.get(number) ?? 0) + 1);
      fake.onGetPr?.(pr, reads.get(number)!);
      return record("getPr", { ...pr });
    },
    getBranchRules: async () => record("getBranchRules", { ...fake.rules, contexts: [...fake.rules.contexts] }),
    reviewRulesBypassable: async () => record("reviewRulesBypassable", fake.reviewBypass),
    listCheckRuns: async (_repo, sha) => record("listCheckRuns", [...(runs.get(sha) ?? [])]),
    createCheckRun: async (target, request) => record("createCheckRun", createCheckRun(fake, runs, options.appId ?? FAKE_APP_ID, target, request, ++counter)),
    getCommit: async (_repo, sha) => record("getCommit", fake.commits.get(sha) ?? { sha, parents: [], tree: fakeSha(`tree:${sha}`) }),
    getWorkflowRunStatus: async (_repo, runId) => record("getWorkflowRunStatus", runStatus.get(runId) ?? "completed"),
    getJobLog: async (_repo, jobId) => {
      const log = fake.jobLogs.get(jobId);
      if (log === undefined) throw new FakeHttpError(404, `no job ${jobId}`);
      return record("getJobLog", log);
    },
    updateBranch: async (_repo, number, expected) => record("updateBranch", updateBranch(fake, mustPr(prs, number), expected, nextSha)),
    merge: async (_repo, number, sha, method) => record("merge", mergePr(fake, mustPr(prs, number), sha, method, nextSha)),
    rerunFailedJobs: async (_repo, runId) => {
      record("rerunFailedJobs", undefined);
      effects.rerunFailedJobs += 1;
      runStatus.set(runId, "queued");
    },
    listPrFiles: async (_repo, number) => {
      const all = fake.prFiles.get(number) ?? [];
      const files = all.slice(0, PR_FILES_CAP).map((file) => ({ ...file }));
      return record("listPrFiles", { files, changedFiles: fake.prChangedFiles.get(number) ?? all.length });
    },
    compareFiles: async (_repo, base, head) => {
      const input = fake.compares.get(`${base}...${head}`) ?? { mergeBaseSha: fake.refs.get(base) ?? base, files: [] };
      const truncated = input.files.length >= COMPARE_FILE_CAP || (input.totalCommits ?? 0) > COMPARE_COMMIT_CAP;
      return record("compareFiles", { mergeBaseSha: input.mergeBaseSha, files: input.files.slice(0, COMPARE_FILE_CAP), truncated });
    },
    getAuthenticatedLogin: async () => record("getAuthenticatedLogin", fake.actor),
    listIssueComments: async (_repo, number) => record("listIssueComments", (fake.comments.get(number) ?? []).map((comment) => ({ ...comment }))),
    createComment: async (_repo, number, body) => {
      record("createComment", undefined);
      const list = fake.comments.get(number) ?? [];
      const comment = { id: 5000 + ++counter, body, author: fake.actor };
      fake.comments.set(number, [...list, comment]);
      return { id: comment.id };
    },
    listReviewComments: async (_repo, number) => record("listReviewComments", (fake.reviewComments.get(number) ?? []).map((comment) => ({ ...comment }))),
  };
  return fake;
}

/** Like GitHub, the run is stamped with the posting App's id, which is what `latestCheckRuns` and `mergeReadiness` read. */
function createCheckRun(fake: FakeGitHub, runs: Map<string, CheckRun[]>, appId: number, repo: string, request: CreateCheckRunRequest, n: number): { id: number } {
  const id = 9000 + n;
  const run: CheckRun = { id, name: request.name, status: "completed", conclusion: request.conclusion, startedAt: "2026-01-01T00:00:00Z", headSha: request.headSha, appId, workflowRunId: null, url: `https://example.test/runs/${id}` };
  fake.createdCheckRuns.push({ id, repo, request: { ...request } });
  runs.set(request.headSha, [...(runs.get(request.headSha) ?? []), run]);
  return { id };
}

/** Like GitHub's list: rows carry no mergeable state or `behind`, so the ETag changes only with what a row shows. */
function revalidateOpenPrs(fake: FakeGitHub, prs: Map<number, PullRequest>, etag: string | null): OpenPrList {
  const rows = [...prs.values()].filter((pr) => pr.state === "open").map((pr) => ({ ...pr, mergeableState: "unknown", behind: false }));
  const current = `W/"${createHash("sha1").update(JSON.stringify(rows)).digest("hex")}"`;
  if (etag === current) {
    fake.notModified += 1;
    return { notModified: true };
  }
  return { notModified: false, prs: rows, etag: current };
}

function mustPr(prs: Map<number, PullRequest>, number: number): PullRequest {
  const pr = prs.get(number);
  if (!pr) throw new FakeHttpError(404, `no pull ${number}`);
  return pr;
}

function putContent(fake: FakeGitHub, request: PutFileRequest, nextSha: (tag: string) => string): { blobSha: string } {
  const key = `${request.branch}:${request.path}`;
  const current = fake.files.get(key);
  if ((current?.blobSha ?? null) !== request.expectedBlobSha) throw new FakeHttpError(409, `${request.path} does not match ${request.expectedBlobSha}`);
  fake.effects.putContent += 1;
  const blobSha = nextSha("blob");
  fake.files.set(key, { content: request.content, blobSha });
  fake.refs.set(request.branch, nextSha("commit"));
  return { blobSha };
}

function createPr(fake: FakeGitHub, request: OpenPrRequest): PullRequest {
  const headSha = fake.refs.get(request.head);
  if (!headSha) throw new FakeHttpError(422, `no branch ${request.head}`);
  fake.effects.createPr += 1;
  return fake.addPr({ headRef: request.head, baseRef: request.base, headSha });
}

/** Like GitHub without force: refused unless the new commit's parent is the branch's tip; an open PR on the branch moves with it. */
function updateRef(fake: FakeGitHub, prs: Map<number, PullRequest>, branch: string, sha: string): void {
  const tip = fake.refs.get(branch);
  if (tip === undefined || !(fake.commits.get(sha)?.parents ?? []).includes(tip)) throw new FakeHttpError(422, "Update is not a fast forward");
  fake.effects.updateRef += 1;
  fake.refs.set(branch, sha);
  for (const pr of prs.values()) if (pr.state === "open" && pr.headRef === branch) pr.headSha = sha;
}

/** Like GitHub: refused unless the head is the expected one; the new head is a merge of head and base. */
function updateBranch(fake: FakeGitHub, pr: PullRequest, expected: string, nextSha: (tag: string) => string): void {
  if (pr.headSha !== expected) throw new FakeHttpError(422, "expected head sha did not match");
  if (fake.updateBranchConflict) throw new FakeHttpError(422, "merge conflict between base and head");
  fake.effects.updateBranch += 1;
  const merged = nextSha("update");
  fake.commits.set(merged, { sha: merged, parents: [pr.headSha, fake.refs.get(pr.baseRef) ?? ""] });
  pr.headSha = merged;
  pr.behind = false;
}

function mergePr(fake: FakeGitHub, pr: PullRequest, sha: string, _method: MergeMethod, nextSha: (tag: string) => string): { sha: string } {
  if (pr.merged || pr.state !== "open") throw new FakeHttpError(405, "Pull Request is not mergeable");
  if (pr.headSha !== sha) throw new FakeHttpError(409, "Head branch was modified");
  if (fake.rules.strict && pr.behind) throw new FakeHttpError(405, "Head branch is not up to date with the base branch");
  fake.effects.merge += 1;
  pr.merged = true;
  pr.state = "closed";
  pr.mergeSha = nextSha("merge");
  return { sha: pr.mergeSha };
}
