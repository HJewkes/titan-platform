import { createHash } from "node:crypto";
import { GITHUB_ACTIONS_APP_ID } from "./readiness.js";
import { COMPARE_COMMIT_CAP, COMPARE_FILE_CAP, PR_COMMITS_CAP, PR_FILES_CAP } from "./port.js";
import type { CreateCheckRunRequest } from "./check-run-create.js";
import { FORCE_PUSHES_CAP, type ForcePush } from "./force-pushes.js";
import type { OpenPrRequest } from "./pr-list.js";
import type { CheckRun, LoggedCommit, MergeMethod, PrFile, PullRequest, PutFileRequest } from "./port.js";
import type { FakeEffects, FakeFaultyRead, FakeGitHub } from "./fake-types.js";
import { fakeMergeIntoBranch } from "./fake-merge-into-branch.js";
import { fakeAncestry, fakeLsRemote } from "./fake-ancestry.js";
import { revalidateOpenPrs, revalidateRef, revalidateRulesets } from "./fake-conditional-reads.js";

export type { FakeEffects, FakeFaultyRead, FakeGitHub } from "./fake-types.js";

export class FakeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}

const attemptKey = (run: CheckRun): string => `${run.name}\u0000${run.appId}\u0000${run.workflowRunId}`;

/** GitHub's default `filter=latest`: a rerun of a job in the same workflow run hides that job's earlier attempts. */
function latestAttempts(runs: readonly CheckRun[]): CheckRun[] {
  const newest = new Map<string, number>();
  for (const run of runs) if (run.workflowRunId !== null) newest.set(attemptKey(run), Math.max(newest.get(attemptKey(run)) ?? run.id, run.id));
  return runs.filter((run) => run.workflowRunId === null || newest.get(attemptKey(run)) === run.id);
}

/** A real-shaped commit sha, stable per tag, so tests can name heads. */
export function fakeSha(tag: string): string {
  return createHash("sha1").update(tag).digest("hex");
}

export function successRun(name: string, id: number, startedAt = "2026-01-01T00:00:00Z", conclusion = "success", appId = GITHUB_ACTIONS_APP_ID, headSha = ""): CheckRun {
  return { id, name, status: "completed", conclusion, startedAt, headSha, appId, workflowRunId: 1000 + id, pullRequests: [], url: `https://example.test/actions/runs/${1000 + id}/job/${id}` };
}

/** The App id the fake posts check runs as unless `fakeGitHub({ appId })` says otherwise. */
export const FAKE_APP_ID = 424242;
const FAKE_MERGED_AT = "2026-01-01T00:00:00Z";

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
    runStatuses: runStatus,
    jobReruns: [],
    calls: [],
    notModified: 0,
    rules: { contexts: ["validate", "dag-check"], strict: true },
    classicRules: { contexts: [], strict: false },
    reviewBypass: false,
    branchProtected: false,
    createdCheckRuns: [],
    commits: new Map(),
    statuses: new Map(),
    readFaults: {},
    refs: new Map([[base, options.baseSha ?? fakeSha("base")]]),
    rulesets: new Map(),
    jobLogs: new Map(),
    jobSteps: new Map(),
    files: new Map(),
    actor: "shepherd-bot",
    prFiles: new Map(),
    prChangedFiles: new Map(),
    prCommits: new Map(),
    squashSources: new Map(),
    merges: [],
    mergeConflicts: new Set(),
    branchMerges: [],
    baseChanges: [],
    history: [],
    compares: new Map(),
    comments: new Map(),
    reviewComments: new Map(),
    forcePushes: new Map(),
    addPr(fields) {
      const pr: PullRequest = { number: prs.size + 1, state: "open", merged: false, mergeSha: null, mergedAt: null, headRef: `topic-${prs.size + 1}`, headRepo: repo, baseRef: base, draft: false, mergeableState: "clean", behind: false, autoMerge: false, ...fields };
      if (pr.merged && pr.mergedAt === null) pr.mergedAt = FAKE_MERGED_AT;
      prs.set(pr.number, pr);
      return { ...pr };
    },
    pr: (number) => mustPr(prs, number),
    setRuns: (sha, list) => runs.set(sha, list.map((run) => ({ ...run, headSha: run.headSha || sha }))),
    pushHead: (number, sha) => {
      mustPr(prs, number).headSha = sha;
    },
  } as Omit<FakeGitHub, "wire" | "gitExec"> as FakeGitHub;
  const record = <T>(name: string, value: T): T => (fake.calls.push(name), value);
  const read = <T>(name: FakeFaultyRead, answer: () => T): T => {
    const fault = (fake.calls.push(name), fake.readFaults[name]?.shift());
    if (fault) throw fault;
    return answer();
  };
  fake.wire = {
    getRef: async (_repo, branch) => record("getRef", fake.refs.get(branch) ?? null),
    createRef: async (_repo, branch, sha) => {
      record("createRef", undefined);
      createRef(fake, branch, sha);
    },
    createCommit: async (_repo, request) => {
      const sha = nextSha("commit");
      fake.commits.set(sha, { sha, parents: [...request.parents], tree: request.tree });
      return record("createCommit", { sha });
    },
    updateRef: async (_repo, branch, sha) => record("updateRef", updateRef(fake, prs, branch, sha)),
    deleteRef: async (_repo, branch) => {
      record("deleteRef", undefined);
      deleteRef(fake, prs, branch);
    },
    getDefaultBranch: async () => read("getDefaultBranch", () => base),
    getContent: async (_repo, path, ref) => record("getContent", getContent(fake, path, ref)),
    putContent: async (_repo, request) => record("putContent", putContent(fake, request, nextSha)),
    listPrs: async (_repo, headBranch) => record("listPrs", [...prs.values()].filter((pr) => pr.headRef === headBranch).map((pr) => ({ ...pr }))),
    listOpenPrs: async () => record("listOpenPrs", [...prs.values()].filter((pr) => pr.state === "open").map((pr) => ({ ...pr }))),
    revalidateOpenPrs: async (_repo, etag) => record("revalidateOpenPrs", revalidateOpenPrs(fake, prs, etag)),
    revalidateRef: async (_repo, branch, etag) => record("revalidateRef", revalidateRef(fake, branch, etag)),
    revalidateRulesets: async (_repo, etag) => record("revalidateRulesets", revalidateRulesets(fake, etag)),
    createPr: async (_repo, request) => record("createPr", createPr(fake, request)),
    getPr: async (_repo, number) => record("getPr", getPr(fake, prs, reads, number)),
    getBranchRules: async () => read("getBranchRules", () => ({ ...fake.rules, contexts: [...fake.rules.contexts] })),
    getClassicRequiredChecks: async () => read("getClassicRequiredChecks", () => ({ ...fake.classicRules, contexts: [...fake.classicRules.contexts] })),
    reviewRulesBypassable: async () => record("reviewRulesBypassable", fake.reviewBypass),
    getBranchProtected: async () => record("getBranchProtected", fake.branchProtected),
    listCheckRuns: async (_repo, sha, filter) => read("listCheckRuns", () => (filter === "all" ? [...(runs.get(sha) ?? [])] : latestAttempts(runs.get(sha) ?? []))),
    createCheckRun: async (target, request) => record("createCheckRun", createCheckRun(fake, runs, options.appId ?? FAKE_APP_ID, target, request, ++counter)),
    getCommit: async (_repo, sha) => record("getCommit", fake.commits.get(sha) ?? { sha, parents: [], tree: fakeSha(`tree:${sha}`) }),
    resolveCommit: async (_repo, sha) => read("resolveCommit", () => resolveCommit(fake, runs, sha)),
    listCommitStatuses: async (_repo, sha) => read("listCommitStatuses", () => (fake.statuses.get(sha) ?? []).map((status) => ({ ...status }))),
    getWorkflowRunStatus: async (_repo, runId) => record("getWorkflowRunStatus", runStatus.get(runId) ?? openJobStatus(runs, runId) ?? "completed"),
    getJobLog: async (_repo, jobId) => {
      const log = mustJob(fake.jobLogs, jobId);
      return record("getJobLog", log);
    },
    getJobSteps: async (_repo, jobId) => {
      const steps = mustJob(fake.jobSteps, jobId);
      return record("getJobSteps", steps.map((one) => ({ ...one })));
    },
    updateBranch: async (_repo, number, expected) => record("updateBranch", updateBranch(fake, mustPr(prs, number), expected, nextSha)),
    setPrBase: async (_repo, number, base) => record("setPrBase", setPrBase(fake, mustPr(prs, number), base)),
    closePr: async (_repo, number) => record("closePr", void (mustPr(prs, number).state = "closed")),
    merge: async (_repo, number, sha, method, message) => {
      record("merge", undefined);
      fake.merges.push({ number, message });
      return mergePr(fake, mustPr(prs, number), sha, method, nextSha);
    },
    mergeIntoBranch: async (_repo, request) => record("mergeIntoBranch", fakeMergeIntoBranch(fake, request, nextSha, (message) => new FakeHttpError(404, message))),
    getSquashSource: async (_repo, number) => record("getSquashSource", fake.squashSources.get(number) ?? { title: "", body: "", commits: [] }),
    rerunFailedJobs: async (_repo, runId) => {
      record("rerunFailedJobs", undefined);
      rerunFailedJobs(fake, runId);
    },
    rerunJob: async (_repo, jobId) => {
      record("rerunJob", undefined);
      rerunJob(fake, runs, jobId);
    },
    listPrFiles: async (_repo, number) => record("listPrFiles", listPrFiles(fake, number)),
    listPrCommits: async (_repo, number) => record("listPrCommits", (fake.prCommits.get(number) ?? [mustPr(prs, number).headSha]).slice(0, PR_COMMITS_CAP)),
    listCommits: async (_repo, since) => record("listCommits", listCommits(fake, since)),
    compareAncestry: async (_repo, base, head) => read("compareAncestry", () => fakeAncestry({ commits: fake.commits, refs: fake.refs, prs }, base, head)),
    compareFiles: async (_repo, base, head) => record("compareFiles", compareFiles(fake, base, head)),
    getAuthenticatedLogin: async () => record("getAuthenticatedLogin", fake.actor),
    listIssueComments: async (_repo, number) => record("listIssueComments", (fake.comments.get(number) ?? []).map((comment) => ({ ...comment }))),
    createComment: async (_repo, number, body) => {
      record("createComment", undefined);
      return createComment(fake, number, body, 5000 + ++counter);
    },
    listReviewComments: async (_repo, number) => record("listReviewComments", (fake.reviewComments.get(number) ?? []).map((comment) => ({ ...comment }))),
    listForcePushes: async (_repo, number) => record("listForcePushes", listForcePushes(fake, number)),
  };
  fake.gitExec = fakeLsRemote(prs, () => read("lsRemote", () => undefined));
  return fake;
}

function createRef(fake: FakeGitHub, branch: string, sha: string): void {
  if (fake.refs.has(branch)) throw new FakeHttpError(422, "Reference already exists");
  fake.effects.createRef += 1;
  fake.refs.set(branch, sha);
}

function deleteRef(fake: FakeGitHub, prs: Map<number, PullRequest>, branch: string): void {
  if (!fake.refs.delete(branch)) throw new FakeHttpError(422, "Reference does not exist");
  fake.effects.deleteRef += 1;
  // An API branch delete closes the PRs based on it; only GitHub's delete-on-merge setting retargets them.
  for (const pr of prs.values()) if (pr.state === "open" && pr.baseRef === branch) pr.state = "closed";
}

function getContent(fake: FakeGitHub, path: string, ref: string): { path: string; blobSha: string; content: string } | null {
  const file = fake.files.get(`${ref}:${path}`);
  return file ? { path, blobSha: file.blobSha, content: file.content } : null;
}

function getPr(fake: FakeGitHub, prs: Map<number, PullRequest>, reads: Map<number, number>, number: number): PullRequest {
  const pr = mustPr(prs, number);
  const count = (reads.get(number) ?? 0) + 1;
  reads.set(number, count);
  fake.onGetPr?.(pr, count);
  return { ...pr };
}

function mustJob<T>(byJob: Map<number, T>, jobId: number): T {
  const found = byJob.get(jobId);
  if (found === undefined) throw new FakeHttpError(404, `no job ${jobId}`);
  return found;
}

function rerunFailedJobs(fake: FakeGitHub, runId: number): void {
  const fault = fake.rerunFaults?.shift();
  if (fault && !fault.lands) throw fault.error;
  fake.effects.rerunFailedJobs += 1;
  fake.runStatuses.set(runId, "queued");
  if (fault) throw fault.error;
}

function rerunJob(fake: FakeGitHub, runs: Map<string, CheckRun[]>, jobId: number): void {
  fake.jobReruns.push(jobId);
  const owner = [...runs.values()].flat().find((run) => run.id === jobId)?.workflowRunId;
  if (owner !== null && owner !== undefined) fake.runStatuses.set(owner, "queued");
}

function listPrFiles(fake: FakeGitHub, number: number): { files: PrFile[]; changedFiles: number } {
  const all = fake.prFiles.get(number) ?? [];
  const files = all.slice(0, PR_FILES_CAP).map((file) => ({ ...file }));
  return { files, changedFiles: fake.prChangedFiles.get(number) ?? all.length };
}

function listCommits(fake: FakeGitHub, since: string): LoggedCommit[] {
  const after = fake.history.filter((commit) => Date.parse(commit.committedAt) >= Date.parse(since));
  return after.sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt)).map(({ sha, message }) => ({ sha, message }));
}

function compareFiles(fake: FakeGitHub, base: string, head: string): { mergeBaseSha: string; files: string[]; truncated: boolean } {
  const input = fake.compares.get(`${base}...${head}`) ?? { mergeBaseSha: fake.refs.get(base) ?? base, files: [] };
  const truncated = input.files.length >= COMPARE_FILE_CAP || (input.totalCommits ?? 0) > COMPARE_COMMIT_CAP;
  return { mergeBaseSha: input.mergeBaseSha, files: input.files.slice(0, COMPARE_FILE_CAP), truncated };
}

function createComment(fake: FakeGitHub, number: number, body: string, id: number): { id: number } {
  const fault = fake.createCommentFaults?.shift();
  if (fault && !fault.lands) throw fault.error;
  const comment = { id, body, author: fake.actor };
  fake.comments.set(number, [...(fake.comments.get(number) ?? []), comment]);
  if (fault) throw fault.error;
  return { id };
}

function listForcePushes(fake: FakeGitHub, number: number): { pushes: ForcePush[]; more: boolean } {
  const all = fake.forcePushes.get(number) ?? [];
  return { pushes: all.slice(0, FORCE_PUSHES_CAP).map((push) => ({ ...push })), more: all.length > FORCE_PUSHES_CAP };
}

/** Like GitHub, a workflow run with a job still queued or in progress has not completed; `runStatuses` overrides it. */
function openJobStatus(runs: Map<string, CheckRun[]>, runId: number): string | undefined {
  return [...runs.values()].flat().find((run) => run.workflowRunId === runId && run.status !== "completed")?.status;
}

/** A commit is known when it was created, is a ref's tip, or has runs or statuses; only a unique prefix expands, as on GitHub. */
function resolveCommit(fake: FakeGitHub, runs: Map<string, CheckRun[]>, sha: string): string | null {
  const matches = [...new Set([...fake.commits.keys(), ...fake.refs.values(), ...runs.keys(), ...fake.statuses.keys()])].filter((full) => full.startsWith(sha));
  return matches.length === 1 ? matches[0]! : null;
}

/** Like GitHub, the run is stamped with the posting App's id, which is what `latestCheckRuns` and `mergeReadiness` read. */
function createCheckRun(fake: FakeGitHub, runs: Map<string, CheckRun[]>, appId: number, repo: string, request: CreateCheckRunRequest, n: number): { id: number } {
  const id = 9000 + n;
  const run: CheckRun = { id, name: request.name, status: "completed", conclusion: request.conclusion, startedAt: "2026-01-01T00:00:00Z", headSha: request.headSha, appId, workflowRunId: null, pullRequests: [], url: `https://example.test/runs/${id}` };
  fake.createdCheckRuns.push({ id, repo, request: { ...request } });
  runs.set(request.headSha, [...(runs.get(request.headSha) ?? []), run]);
  return { id };
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
  const fault = fake.updateBranchFaults?.shift();
  if (fault) {
    if (fault.lands) landUpdate(fake, pr, nextSha);
    throw fault.error;
  }
  if (pr.headSha !== expected) throw new FakeHttpError(422, "expected head sha did not match");
  if (fake.updateBranchConflict) throw new FakeHttpError(422, "merge conflict between base and head");
  landUpdate(fake, pr, nextSha);
}

function landUpdate(fake: FakeGitHub, pr: PullRequest, nextSha: (tag: string) => string): void {
  fake.effects.updateBranch += 1;
  const merged = nextSha("update");
  fake.commits.set(merged, { sha: merged, parents: [pr.headSha, fake.refs.get(pr.baseRef) ?? ""] });
  pr.headSha = merged;
  pr.behind = false;
}

/** Like GitHub: a closed PR or a base branch that does not exist answers 422. */
function setPrBase(fake: FakeGitHub, pr: PullRequest, base: string): void {
  if (pr.state !== "open") throw new FakeHttpError(422, "Cannot change the base branch of a closed pull request");
  if (!fake.refs.has(base)) throw new FakeHttpError(422, `Proposed base branch '${base}' was not found`);
  fake.baseChanges.push({ number: pr.number, base });
  pr.baseRef = base;
}

function mergePr(fake: FakeGitHub, pr: PullRequest, sha: string, _method: MergeMethod, nextSha: (tag: string) => string): { sha: string } {
  const fault = fake.mergeFaults?.shift();
  if (fault && !fault.lands) throw fault.error;
  const merged = landMerge(fake, pr, sha, nextSha);
  if (fault) throw fault.error;
  return merged;
}

function landMerge(fake: FakeGitHub, pr: PullRequest, sha: string, nextSha: (tag: string) => string): { sha: string } {
  if (pr.merged || pr.state !== "open") throw new FakeHttpError(405, "Pull Request is not mergeable");
  if (pr.headSha !== sha) throw new FakeHttpError(409, "Head branch was modified");
  if (fake.rules.strict && pr.behind) throw new FakeHttpError(405, "Head branch is not up to date with the base branch");
  fake.effects.merge += 1;
  pr.merged = true;
  pr.state = "closed";
  pr.mergeSha = nextSha("merge");
  pr.mergedAt = FAKE_MERGED_AT;
  fake.refs.set(pr.baseRef, pr.mergeSha);
  return { sha: pr.mergeSha };
}
