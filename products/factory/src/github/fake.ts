import type { CheckRun, Commit, GitHubWire, MergeMethod, OpenPrRequest, PullRequest, PutFileRequest, RequiredChecks } from "./port.js";

/** Counts of calls that change GitHub; a crash test asserts each is at most one. */
export interface FakeEffects {
  createRef: number;
  putContent: number;
  createPr: number;
  updateBranch: number;
  merge: number;
  rerunFailedJobs: number;
}

export interface FakeGitHub {
  wire: GitHubWire;
  effects: FakeEffects;
  /** Every wire call in order, as `method` names; lets a test prove what was never called. */
  calls: string[];
  rules: RequiredChecks;
  addPr(fields: Partial<PullRequest> & { headSha: string }): PullRequest;
  /** The live record, so a test can move the world (behind, mergeable_state) between steps. */
  pr(number: number): PullRequest;
  /** Stored as given; picking the latest run per name is the port's job. */
  setRuns(sha: string, runs: CheckRun[]): void;
  /** A foreign push: moves the PR head without this run doing it. */
  pushHead(number: number, sha: string): void;
  /** Called at the start of every `getPr`, so a test can move the world between polls. */
  onGetPr?: (pr: PullRequest, reads: number) => void;
  commits: Map<string, Commit>;
  refs: Map<string, string>;
  files: Map<string, { content: string; blobSha: string }>;
}

export class FakeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}

export function successRun(name: string, id: number, startedAt = "2026-01-01T00:00:00Z", conclusion = "success"): CheckRun {
  return { id, name, status: "completed", conclusion, startedAt, workflowRunId: 1000 + id, url: `https://example.test/actions/runs/${1000 + id}/job/${id}` };
}

/** An in-memory GitHub: one repo slug per key, strict rules, and unconditional writes like the real API. */
export function fakeGitHub(options: { base?: string; baseSha?: string } = {}): FakeGitHub {
  const base = options.base ?? "main";
  let counter = 0;
  const nextSha = (tag: string): string => `${tag}${String(++counter).padStart(4, "0")}`;
  const effects: FakeEffects = { createRef: 0, putContent: 0, createPr: 0, updateBranch: 0, merge: 0, rerunFailedJobs: 0 };
  const prs = new Map<number, PullRequest>();
  const runs = new Map<string, CheckRun[]>();
  const runStatus = new Map<number, string>();
  const reads = new Map<number, number>();
  const fake: FakeGitHub = {
    effects,
    calls: [],
    rules: { contexts: ["validate", "dag-check"], strict: true },
    commits: new Map(),
    refs: new Map([[base, options.baseSha ?? "base0000"]]),
    files: new Map(),
    addPr(fields) {
      const pr: PullRequest = { number: prs.size + 1, state: "open", merged: false, mergeSha: null, headRef: `topic-${prs.size + 1}`, baseRef: base, draft: false, mergeableState: "clean", behind: false, ...fields };
      prs.set(pr.number, pr);
      return { ...pr };
    },
    pr: (number) => mustPr(prs, number),
    setRuns: (sha, list) => runs.set(sha, list),
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
    getContent: async (_repo, path, ref) => {
      const file = fake.files.get(`${ref}:${path}`);
      return record("getContent", file ? { path, blobSha: file.blobSha, content: file.content } : null);
    },
    putContent: async (_repo, request) => record("putContent", putContent(fake, request, nextSha)),
    listPrs: async (_repo, headBranch) => record("listPrs", [...prs.values()].filter((pr) => pr.headRef === headBranch).map((pr) => ({ ...pr }))),
    createPr: async (_repo, request) => record("createPr", createPr(fake, request)),
    getPr: async (_repo, number) => {
      const pr = mustPr(prs, number);
      reads.set(number, (reads.get(number) ?? 0) + 1);
      fake.onGetPr?.(pr, reads.get(number)!);
      return record("getPr", { ...pr });
    },
    getBranchRules: async () => record("getBranchRules", { ...fake.rules, contexts: [...fake.rules.contexts] }),
    listCheckRuns: async (_repo, sha) => record("listCheckRuns", [...(runs.get(sha) ?? [])]),
    getCommit: async (_repo, sha) => record("getCommit", fake.commits.get(sha) ?? { sha, parents: [] }),
    getWorkflowRunStatus: async (_repo, runId) => record("getWorkflowRunStatus", runStatus.get(runId) ?? "completed"),
    updateBranch: async (_repo, number, expected) => record("updateBranch", updateBranch(fake, mustPr(prs, number), expected, nextSha)),
    merge: async (_repo, number, sha, method) => record("merge", mergePr(fake, mustPr(prs, number), sha, method, nextSha)),
    rerunFailedJobs: async (_repo, runId) => {
      record("rerunFailedJobs", undefined);
      effects.rerunFailedJobs += 1;
      runStatus.set(runId, "queued");
    },
  };
  return fake;
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

/** Like GitHub: refused unless the head is the expected one; the new head is a merge of head and base. */
function updateBranch(fake: FakeGitHub, pr: PullRequest, expected: string, nextSha: (tag: string) => string): void {
  if (pr.headSha !== expected) throw new FakeHttpError(422, "expected head sha did not match");
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
