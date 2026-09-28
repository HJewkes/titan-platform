import { execFile } from "node:child_process";
import type { CheckRun, Commit, GitHubWire, PullRequest, RepoFile, RequiredChecks } from "./port.js";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `gh` with an argv array and optional stdin; never through a shell. */
export type GhExec = (args: readonly string[], input?: string) => Promise<GhResult>;

export class GhError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GhResult,
  ) {
    super(`gh ${args.slice(0, 4).join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GhError";
  }

  get status(): number | undefined {
    const match = /\(HTTP (\d{3})\)/.exec(this.result.stderr);
    return match ? Number(match[1]) : undefined;
  }
}

/** Uses the caller's existing `gh` login; this module never sees a token. */
export const execGh: GhExec = (args, input) =>
  new Promise((resolve) => {
    const child = execFile("gh", [...args], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
  });

export function ghCliWire(exec: GhExec = execGh): GitHubWire {
  const api = apiCaller(exec);
  return {
    getRef: async (repo, branch) => (await api.getOrNull<{ object: { sha: string } }>([`repos/${repo}/git/ref/heads/${branch}`]))?.object.sha ?? null,
    createRef: async (repo, branch, sha) => void (await api.call(["-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha}`])),
    getContent: (repo, path, ref) => getContent(api, repo, path, ref),
    putContent: async (repo, request) => {
      const body = { message: request.message, content: Buffer.from(request.content, "utf8").toString("base64"), branch: request.branch, ...(request.expectedBlobSha ? { sha: request.expectedBlobSha } : {}) };
      const written = await api.call<{ content: { sha: string } }>(["-X", "PUT", `repos/${repo}/contents/${request.path}`, "--input", "-"], JSON.stringify(body));
      return { blobSha: written.content.sha };
    },
    listPrs: async (repo, headBranch) => {
      const prs = await api.call<GhPull[]>(["-X", "GET", `repos/${repo}/pulls`, "-f", `head=${repo.split("/")[0]}:${headBranch}`, "-f", "state=all", "-f", "per_page=100"]);
      return prs.map((pr) => toPullRequest(pr, false));
    },
    createPr: async (repo, request) => toPullRequest(await api.call<GhPull>(["-X", "POST", `repos/${repo}/pulls`, "--input", "-"], JSON.stringify(request)), false),
    getPr: (repo, number) => getPr(api, repo, number),
    getBranchRules: async (repo, branch) => requiredChecksFrom(await api.call<GhRule[]>([`repos/${repo}/rules/branches/${branch}`])),
    listCheckRuns: (repo, sha) => listCheckRuns(api, repo, sha),
    getCommit: async (repo, sha) => {
      const commit = await api.call<{ sha: string; parents: { sha: string }[] }>([`repos/${repo}/git/commits/${sha}`]);
      return { sha: commit.sha, parents: commit.parents.map((parent) => parent.sha) } satisfies Commit;
    },
    getWorkflowRunStatus: async (repo, runId) => (await api.call<{ status: string }>([`repos/${repo}/actions/runs/${runId}`])).status,
    updateBranch: async (repo, number, expectedHeadSha) => void (await api.call(["-X", "PUT", `repos/${repo}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${expectedHeadSha}`])),
    merge: async (repo, number, sha, method) => ({ sha: (await api.call<{ sha: string }>(["-X", "PUT", `repos/${repo}/pulls/${number}/merge`, "-f", `sha=${sha}`, "-f", `merge_method=${method}`])).sha }),
    rerunFailedJobs: async (repo, runId) => void (await api.call(["-X", "POST", `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`])),
  };
}

interface ApiCaller {
  call<T = unknown>(args: readonly string[], input?: string): Promise<T>;
  getOrNull<T>(args: readonly string[]): Promise<T | null>;
  lines<T>(args: readonly string[]): Promise<T[]>;
}

function apiCaller(exec: GhExec): ApiCaller {
  const raw = async (args: readonly string[], input?: string): Promise<string> => {
    const full = ["api", ...args];
    const result = await exec(full, input);
    if (result.code !== 0) throw new GhError(full, result);
    return result.stdout;
  };
  return {
    call: async (args, input) => {
      const out = await raw(args, input);
      return (out.trim() ? JSON.parse(out) : undefined) as never;
    },
    getOrNull: async (args) => {
      try {
        return JSON.parse(await raw(args));
      } catch (error) {
        if (error instanceof GhError && error.status === 404) return null;
        throw error;
      }
    },
    lines: async (args) => (await raw(args)).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)),
  };
}

async function getContent(api: ApiCaller, repo: string, path: string, ref: string): Promise<RepoFile | null> {
  const file = await api.getOrNull<{ path: string; sha: string; content: string; encoding: string }>(["-X", "GET", `repos/${repo}/contents/${path}`, "-f", `ref=${ref}`]);
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
  head: { ref: string; sha: string };
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
    baseRef: pr.base.ref,
    draft: pr.draft ?? false,
    mergeableState: pr.mergeable_state ?? "unknown",
    behind,
  };
}

/** `behind` comes from the compare API, which is exact, not from the lazily computed `mergeable_state`. */
async function getPr(api: ApiCaller, repo: string, number: number): Promise<PullRequest> {
  const pr = await api.call<GhPull>([`repos/${repo}/pulls/${number}`]);
  if (pr.state !== "open") return toPullRequest(pr, false);
  const compare = await api.call<{ behind_by: number }>([`repos/${repo}/compare/${pr.base.ref}...${pr.head.sha}`, "--jq", "{behind_by}"]);
  return toPullRequest(pr, compare.behind_by > 0);
}

interface GhRule {
  type: string;
  parameters?: { strict_required_status_checks_policy?: boolean; required_status_checks?: { context: string }[] };
}

function requiredChecksFrom(rules: readonly GhRule[]): RequiredChecks {
  const statusRules = rules.filter((rule) => rule.type === "required_status_checks");
  const contexts = new Set(statusRules.flatMap((rule) => rule.parameters?.required_status_checks?.map((check) => check.context) ?? []));
  return { contexts: [...contexts].sort(), strict: statusRules.some((rule) => rule.parameters?.strict_required_status_checks_policy === true) };
}

const CHECK_RUN_JQ = ".check_runs[] | {id, name, status, conclusion, started_at, details_url, html_url}";

async function listCheckRuns(api: ApiCaller, repo: string, sha: string): Promise<CheckRun[]> {
  type Line = { id: number; name: string; status: string; conclusion: string | null; started_at: string | null; details_url: string | null; html_url: string | null };
  const lines = await api.lines<Line>(["-X", "GET", `repos/${repo}/commits/${sha}/check-runs`, "-f", "per_page=100", "--paginate", "--jq", CHECK_RUN_JQ]);
  return lines.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.started_at,
    workflowRunId: workflowRunIdOf(run.details_url ?? run.html_url),
    url: run.html_url ?? run.details_url ?? "",
  }));
}

/** Actions job URLs read `.../actions/runs/<runId>/job/<jobId>`. */
function workflowRunIdOf(url: string | null): number | null {
  const match = url ? /\/actions\/runs\/(\d+)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}
