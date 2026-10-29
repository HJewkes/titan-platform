import path from "node:path";
import { execGh, type GhExec } from "@titan-design/github";
import { runGit, type GitRunner } from "@titan-design/worktree";
import { githubSlug } from "./repo-evidence.js";

interface BranchPr {
  number: number;
  state: string;
  title: string;
  url: string;
  checks?: string;
}

interface BranchState {
  /** Directory name of the clone; never an absolute path. */
  repo: string;
  name: string;
  note?: string;
  present: boolean;
  pr: BranchPr | null;
}

export interface BranchStates {
  branches: BranchState[];
  /** Why PR state is missing for some branches, such as GitHub being unreachable. */
  degraded: string[];
}

export interface BranchInput {
  /** Absolute clone path, as `artifacts.yml` records it. */
  repo: string;
  name: string;
  note?: string;
}

export type BranchStateReader = (branches: readonly BranchInput[]) => Promise<BranchStates>;

interface BranchPrOptions {
  git?: GitRunner;
  gh?: GhExec;
  ttlMs?: number;
  now?: () => number;
}

const PR_TTL_MS = 60_000;
/** The newest PRs per repository; a branch whose PR is older than these reads as having none. */
const PR_LIST_LIMIT = 200;
const GH_TIMEOUT_MS = 8_000;

type RepoPrs = { prs: Map<string, BranchPr>; degraded?: string };

/** One `gh pr list` per GitHub repository per minute, however many branches or task pages ask. */
export function branchStateReader(options: BranchPrOptions = {}): BranchStateReader {
  const git = options.git ?? runGit;
  const gh = options.gh ?? execGh;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; read: Promise<RepoPrs> }>();
  const prsOf = (slug: string): Promise<RepoPrs> => {
    const hit = cache.get(slug);
    if (hit && now() - hit.at < (options.ttlMs ?? PR_TTL_MS)) return hit.read;
    const read = listPrs(gh, slug);
    cache.set(slug, { at: now(), read });
    return read;
  };
  return async (branches) => {
    const repos = [...new Set(branches.map((branch) => branch.repo))];
    const slugs = new Map(await Promise.all(repos.map(async (repo) => [repo, githubSlug((await git(["remote", "get-url", "origin"], repo)) ?? "")] as const)));
    const prs = new Map(await Promise.all(repos.map(async (repo) => [repo, await prsFor(slugs.get(repo) ?? null, repo, prsOf)] as const)));
    const states = await Promise.all(branches.map((branch) => stateOf(branch, git, prs.get(branch.repo)!)));
    return { branches: states, degraded: [...new Set([...prs.values()].flatMap((entry) => (entry.degraded ? [entry.degraded] : [])))] };
  };
}

function prsFor(slug: string | null, repo: string, prsOf: (slug: string) => Promise<RepoPrs>): Promise<RepoPrs> {
  if (slug === null) return Promise.resolve({ prs: new Map(), degraded: `${path.basename(repo)} has no GitHub origin` });
  return prsOf(slug);
}

async function stateOf(branch: BranchInput, git: GitRunner, repoPrs: RepoPrs): Promise<BranchState> {
  const present = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch.name}`], branch.repo)) !== null;
  return { repo: path.basename(branch.repo), name: branch.name, ...(branch.note ? { note: branch.note } : {}), present, pr: repoPrs.prs.get(branch.name) ?? null };
}

interface GhPr {
  headRefName: string;
  number: number;
  state: string;
  title: string;
  url: string;
  statusCheckRollup?: { conclusion?: string | null; state?: string | null }[];
}

async function listPrs(gh: GhExec, slug: string): Promise<RepoPrs> {
  const fields = "headRefName,number,state,title,url,statusCheckRollup";
  try {
    const result = await gh(["pr", "list", "--repo", slug, "--state", "all", "--limit", String(PR_LIST_LIMIT), "--json", fields], undefined, { timeoutMs: GH_TIMEOUT_MS });
    if (result.code !== 0) return { prs: new Map(), degraded: `Pull requests in ${slug} unread: ${result.stderr.trim() || `gh exited ${result.code}`}` };
    return { prs: newestByHead(JSON.parse(result.stdout) as GhPr[]) };
  } catch (error) {
    return { prs: new Map(), degraded: `Pull requests in ${slug} unread: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** `gh pr list` answers newest first, so the first PR seen for a head is the one a branch shows. */
function newestByHead(prs: readonly GhPr[]): Map<string, BranchPr> {
  const byHead = new Map<string, BranchPr>();
  for (const pr of prs) {
    if (byHead.has(pr.headRefName)) continue;
    const checks = summarizeChecks(pr.statusCheckRollup ?? []);
    byHead.set(pr.headRefName, { number: pr.number, state: pr.state, title: pr.title, url: pr.url, ...(checks ? { checks } : {}) });
  }
  return byHead;
}

/** The same summary active-work's `artifact.status` wrote, so the page reads the same words. */
function summarizeChecks(rollup: readonly { conclusion?: string | null; state?: string | null }[]): string | undefined {
  if (rollup.length === 0) return undefined;
  const tags = rollup.map((entry) => (entry.conclusion || entry.state || "").toUpperCase());
  const fail = tags.filter((tag) => tag === "FAILURE" || tag === "CANCELLED" || tag === "TIMED_OUT").length;
  const pass = tags.filter((tag) => tag === "SUCCESS").length;
  if (fail > 0) return `fail (${fail}/${rollup.length})`;
  if (pass < rollup.length) return `pending (${rollup.length - pass}/${rollup.length})`;
  return `pass (${pass}/${rollup.length})`;
}
