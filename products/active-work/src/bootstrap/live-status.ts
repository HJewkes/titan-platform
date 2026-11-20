import type { BranchEntry } from "../schemas/artifacts.js";
import {
  getGhRunner,
  resolveLocalRepoPath,
  resolveOrgRepo,
} from "../utils/git-gh.js";
import {
  parseGhPrList,
  type GhPrList,
  type GhPrListEntry as GhPrEntry,
} from "../utils/gh-pr-wire.js";
import {
  isBranchPresent,
  readAheadBehind,
  readLastCommitIso,
  summarizeChecks,
} from "../utils/branch-probes.js";
import { mapConcurrent } from "../utils/map-concurrent.js";
import type { LiveBranchStatus } from "./prompt.js";

export const LIVE_RENDER_LIMIT = 10;
const LIVE_GIT_CONCURRENCY = 5;
const BULK_PR_LIMIT = 200;

type BranchPr = NonNullable<LiveBranchStatus["pr"]>;

/**
 * Open PRs of one repo by head branch, newest first per head as `gh` lists
 * them. `complete` is false when the list hit its limit, so a head missing
 * from it may still have a PR.
 */
interface RepoPrIndex {
  byHead: Map<string, GhPrEntry>;
  complete: boolean;
}

/**
 * Default fetcher used when the caller doesn't supply one. Mirrors the
 * read logic in `artifact.status` but is bounded in parallelism and
 * swallows per-branch errors silently — bootstrap never throws on artifact
 * issues.
 *
 * One `gh pr list` per distinct repo answers every branch in it; a branch
 * the list cannot vouch for falls back to its own `--head` query. Both list
 * open PRs only, as the per-branch query always has.
 */
export async function defaultLiveStatusFetcher(
  branches: BranchEntry[]
): Promise<LiveBranchStatus[]> {
  const shown = branches.slice(0, LIVE_RENDER_LIMIT);
  const [statuses, prs] = await Promise.all([
    mapConcurrent(shown, LIVE_GIT_CONCURRENCY, fetchGitStatus),
    fetchBranchPrs(shown),
  ]);
  return statuses.map((status, i) => ({ ...status, pr: prs[i] ?? null }));
}

async function fetchBranchPrs(
  branches: BranchEntry[]
): Promise<Array<BranchPr | null>> {
  const orgRepos = await Promise.all(
    branches.map((b) => resolveOrgRepo(b.repo).catch(() => null))
  );
  const indexes = new Map<string, Promise<RepoPrIndex | null>>();
  for (const orgRepo of orgRepos) {
    if (orgRepo && !indexes.has(orgRepo))
      indexes.set(orgRepo, listRepoPrs(orgRepo));
  }
  return Promise.all(
    branches.map(async (branch, i) => {
      const orgRepo = orgRepos[i];
      if (!orgRepo) return null;
      const index = await indexes.get(orgRepo)!;
      const listed = index?.byHead.get(branch.name);
      if (listed) return toBranchPr(listed);
      if (index?.complete) return null;
      return fetchPrForHead(orgRepo, branch.name);
    })
  );
}

async function listRepoPrs(orgRepo: string): Promise<RepoPrIndex | null> {
  const fields = "headRefName,number,state,title,url,statusCheckRollup";
  const args = ["pr", "list", "--repo", orgRepo, "--json", fields];
  const list = await runGhPrList([...args, "--limit", String(BULK_PR_LIMIT)]);
  if (!list) return null;
  const byHead = new Map<string, GhPrEntry>();
  for (const entry of list.entries) {
    const head = entry.headRefName;
    if (typeof head === "string" && !byHead.has(head)) byHead.set(head, entry);
  }
  return { byHead, complete: list.total < BULK_PR_LIMIT };
}

async function fetchPrForHead(
  orgRepo: string,
  head: string
): Promise<BranchPr | null> {
  const fields = "number,state,title,url,statusCheckRollup";
  const args = [
    "pr",
    "list",
    "--head",
    head,
    "--repo",
    orgRepo,
    "--json",
    fields,
  ];
  const list = await runGhPrList([...args, "--limit", "1"]);
  const first = list?.entries[0];
  return first ? toBranchPr(first) : null;
}

/** PR lookup is best-effort: any failure reads as "no answer", and a bad element is skipped. */
async function runGhPrList(args: string[]): Promise<GhPrList | null> {
  try {
    const res = await getGhRunner()("gh", args);
    if (res.code !== 0) return null;
    const list = parseGhPrList(res.stdout);
    if (list && list.skipped > 0) {
      process.stderr.write(
        `bootstrap: skipped ${list.skipped} malformed gh pr list entries\n`
      );
    }
    return list;
  } catch {
    return null;
  }
}

function toBranchPr(entry: GhPrEntry): BranchPr | null {
  const { number, state, title, url } = entry;
  if (
    typeof number !== "number" ||
    typeof state !== "string" ||
    typeof title !== "string" ||
    typeof url !== "string"
  ) {
    return null;
  }
  const checks = summarizeChecks(entry.statusCheckRollup ?? []);
  return { number, state, title, url, ...(checks ? { checks } : {}) };
}

async function fetchGitStatus(branch: BranchEntry): Promise<LiveBranchStatus> {
  const out: LiveBranchStatus = {
    repo: branch.repo,
    name: branch.name,
    ...(branch.note ? { note: branch.note } : {}),
    present: false,
    last_commit_iso: null,
    ahead: null,
    behind: null,
    pr: null,
  };
  const repoPath = resolveLocalRepoPath(branch.repo);
  if (!repoPath) return out;
  out.present = await isBranchPresent(repoPath, branch.name);
  if (!out.present) return out;
  out.last_commit_iso = await readLastCommitIso(repoPath, branch.name);
  const counts = await readAheadBehind(repoPath, branch.name);
  out.ahead = counts.ahead;
  out.behind = counts.behind;
  return out;
}
