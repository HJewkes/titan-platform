import type { CheckRun, GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";

/** The reads `ci-wait` and `sh-observe` make, so either can come from the port or from the snapshot. */
export interface PrReads {
  getPr(repo: RepoSlug, number: number): Promise<PullRequest>;
  /** Every run on `sha`; `settled` says the runs that decide the head are all complete, so they need no re-read while pending. */
  checkRuns(repo: RepoSlug, sha: string, settled: (runs: readonly CheckRun[]) => boolean): Promise<CheckRun[]>;
}

/**
 * One poller per repo for every waiting run in it. It may answer pending, red or behind on its own; a green that a
 * merge will act on is confirmed through the port first (`readCi`), and every write re-reads its PR.
 */
export interface PrSnapshot extends PrReads {
  /** Drops what the snapshot holds for `repo`; call it after a write there, so the next read sees the write. */
  invalidate(repo: RepoSlug): void;
}

interface PrSnapshotOptions {
  now?: () => number;
  /** One conditional open-list read per repo per tick. */
  tickMs?: number;
  /** How often a pending head's check runs, or an unsettled mergeable state, are read again. */
  pendingMs?: number;
  /** How long a settled read is trusted: the backstop for a base push that changes no open PR. */
  settledMs?: number;
}

const SNAPSHOT_TICK_MS = 60_000;
const SNAPSHOT_PENDING_MS = 3 * 60_000;
const SNAPSHOT_SETTLED_MS = 30 * 60_000;

interface Timing {
  now: () => number;
  tickMs: number;
  pendingMs: number;
  settledMs: number;
}

interface Detail {
  pr: PullRequest;
  at: number;
  epoch: number;
  checksVersion: number;
}

interface Checks {
  runs: CheckRun[];
  at: number;
  settled: boolean;
  /** Bumped when the runs settle anew, so a detail read before they settled is read again. */
  version: number;
}

interface RepoState {
  list?: { etag: string | null; rows: Map<number, PullRequest>; at: number };
  listing?: Promise<void>;
  /** Bumped when a PR leaves the open list: a merge may have moved the base under every other PR. */
  epoch: number;
  details: Map<number, Detail>;
  checks: Map<string, Checks>;
}

export function prSnapshot(port: GitHubPort, options: PrSnapshotOptions = {}): PrSnapshot {
  const timing: Timing = { now: options.now ?? Date.now, tickMs: options.tickMs ?? SNAPSHOT_TICK_MS, pendingMs: options.pendingMs ?? SNAPSHOT_PENDING_MS, settledMs: options.settledMs ?? SNAPSHOT_SETTLED_MS };
  const repos = new Map<string, RepoState>();
  const stateOf = (repo: RepoSlug): RepoState => {
    const key = repo.toLowerCase();
    if (!repos.has(key)) repos.set(key, { epoch: 0, details: new Map(), checks: new Map() });
    return repos.get(key)!;
  };
  return {
    getPr: async (repo, number) => snapshotPr(port, timing, repo, await listed(port, timing, repo, stateOf(repo)), number),
    checkRuns: async (repo, sha, settled) => snapshotRuns(port, timing, repo, stateOf(repo), sha, settled),
    invalidate: (repo) => void repos.delete(repo.toLowerCase()),
  };
}

/** Concurrent readers of one repo share one list read per tick. */
async function listed(port: GitHubPort, timing: Timing, repo: RepoSlug, state: RepoState): Promise<RepoState> {
  if (state.list && timing.now() - state.list.at < timing.tickMs) return state;
  state.listing ??= refreshList(port, timing, repo, state).finally(() => (state.listing = undefined));
  await state.listing;
  return state;
}

async function refreshList(port: GitHubPort, timing: Timing, repo: RepoSlug, state: RepoState): Promise<void> {
  const read = await port.revalidateOpenPrs(repo, state.list?.etag ?? null);
  if (read.notModified) return void (state.list!.at = timing.now());
  const rows = new Map(read.prs.map((pr) => [pr.number, pr]));
  if (state.list && [...state.list.rows.keys()].some((number) => !rows.has(number))) state.epoch += 1;
  state.list = { etag: read.etag, rows, at: timing.now() };
  const heads = new Set(read.prs.map((pr) => pr.headSha));
  for (const number of state.details.keys()) if (!rows.has(number)) state.details.delete(number);
  for (const sha of state.checks.keys()) if (!heads.has(sha)) state.checks.delete(sha);
}

/** A PR off the open list is closed, merged or newer than the list, so it is read from GitHub every time. */
async function snapshotPr(port: GitHubPort, timing: Timing, repo: RepoSlug, state: RepoState, number: number): Promise<PullRequest> {
  const row = state.list?.rows.get(number);
  if (!row) return port.getPr(repo, number);
  const cached = state.details.get(number);
  if (cached && !detailStale(cached, row, state, timing)) return { ...cached.pr };
  const pr = await port.getPr(repo, number);
  state.details.set(number, { pr, at: timing.now(), epoch: state.epoch, checksVersion: state.checks.get(pr.headSha)?.version ?? 0 });
  return { ...pr };
}

function detailStale(cached: Detail, row: PullRequest, state: RepoState, timing: Timing): boolean {
  if (cached.pr.headSha !== row.headSha || cached.pr.draft !== row.draft || cached.epoch !== state.epoch) return true;
  if ((state.checks.get(row.headSha)?.version ?? 0) !== cached.checksVersion) return true;
  const ttl = cached.pr.mergeableState === "unknown" ? timing.pendingMs : timing.settledMs;
  return timing.now() - cached.at >= ttl;
}

/** A head's runs are read when it is new, while a required check is still pending, and once per settled window. */
async function snapshotRuns(port: GitHubPort, timing: Timing, repo: RepoSlug, state: RepoState, sha: string, isSettled: (runs: readonly CheckRun[]) => boolean): Promise<CheckRun[]> {
  const cached = state.checks.get(sha);
  if (cached && timing.now() - cached.at < (cached.settled ? timing.settledMs : timing.pendingMs)) return [...cached.runs];
  const runs = await port.checkRuns(repo, sha);
  const settled = isSettled(runs);
  state.checks.set(sha, { runs, at: timing.now(), settled, version: nextVersion(cached, runs, settled) });
  return [...runs];
}

/** GitHub recomputes the mergeable state when checks settle, so only a newly settled set of runs makes a detail stale. */
function nextVersion(cached: Checks | undefined, runs: CheckRun[], settled: boolean): number {
  if (!cached) return 0;
  const resettled = settled && (!cached.settled || JSON.stringify(cached.runs) !== JSON.stringify(runs));
  return cached.version + (resettled ? 1 : 0);
}

/** The port itself, for a caller with no snapshot wired. */
export function portReads(port: GitHubPort): PrReads {
  return { getPr: (repo, number) => port.getPr(repo, number), checkRuns: (repo, sha) => port.checkRuns(repo, sha) };
}
