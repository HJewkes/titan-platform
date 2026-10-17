import {
  CONTEXTS_QUERY,
  REVIEWS_QUERY,
  SNAPSHOT_QUERY,
  postWhole,
  type GhCommit,
  type GhConnection,
  type GhContext,
  type GhContextsData,
  type GhDonePr,
  type GhHistoryTarget,
  type GhOpenPr,
  type GhReview,
  type GhReviews,
  type GhReviewsData,
  type GhSnapshotData,
  type RateLimit,
} from "./backstop-query.js";
import type { Rest } from "./rest.js";

export type { RateLimit } from "./backstop-query.js";
export { graphqlPoints, snapshotRequests } from "./backstop-query.js";

/** Page caps per range: past one, the read throws rather than answer a range cut short. */
export const BACKSTOP_CAPS = { open: 20, done: 10, main: 20, contexts: 10, reviews: 10 } as const;

export type BackstopRange = keyof typeof BACKSTOP_CAPS;

/** Re-reads `done` this far behind its cursor, so a PR closed as the last tick read is not missed. */
export const DONE_OVERLAP_MS = 10 * 60 * 1000;

/** Named so a caller that reports only an error's class still says the range was cut short. */
export class BackstopTruncated extends Error {
  constructor(
    readonly range: BackstopRange,
    readonly cap: number,
  ) {
    super(`the backstop's ${range} range runs past ${cap} pages; do not decide from a partial range`);
    this.name = "BackstopTruncated";
  }
}

export interface BackstopRequest {
  repo: string;
  branch: string;
  /** The oldest main commit time to read (GitTimestamp). */
  since: string;
  /** The newest main commit already observed; history stops before it. Null reads back to `since`. */
  mainCursor: string | null;
  /** The closed-PR cursor: `done` pages until `updatedAt` is older than this, less `DONE_OVERLAP_MS`. */
  doneSince: string;
}

export type RollupContext =
  | { kind: "check"; databaseId: number; name: string; status: string; conclusion: string | null; completedAt: string | null }
  | { kind: "status"; context: string; state: string; createdAt: string };

export type BackstopReview = GhReview;

export interface BackstopCommit {
  oid: string;
  contexts: RollupContext[];
}

export interface BackstopOpenPr {
  number: number;
  headRefOid: string;
  baseRefName: string;
  updatedAt: string;
  /** The PR's last commit and its rollup; null on a PR GitHub answers with no commits. */
  head: BackstopCommit | null;
  /** Oldest first. */
  reviews: BackstopReview[];
}

export interface BackstopDonePr {
  number: number;
  merged: boolean;
  mergedBy: string | null;
  mergeCommit: string | null;
  closedAt: string | null;
  updatedAt: string;
}

export interface BackstopSnapshot {
  open: BackstopOpenPr[];
  done: BackstopDonePr[];
  /** `tip` is the branch head at the first page; `commits` are newest first, back to the cursor or `since`. */
  main: { tip: string; commits: BackstopCommit[] };
  /** `cost` sums every query the read sent; `remaining` and `resetAt` are the last query's. */
  rateLimit: RateLimit & { queries: number };
}

interface Range {
  after: string | null;
  pages: number;
  more: boolean;
}

interface Pending {
  open: GhOpenPr[];
  done: GhDonePr[];
  tip: string | null;
  commits: GhCommit[];
}

/**
 * One repo's backstop snapshot: open PRs with their head rollup and reviews, PRs closed since the cursor, and main's
 * history since its cursor. Every range is read whole; GraphQL has no conditional requests, so the caller gates it.
 */
export async function readBackstopSnapshot(api: Rest, request: BackstopRequest): Promise<BackstopSnapshot> {
  const [owner, name] = request.repo.split("/");
  const meter = rateMeter();
  const post = async <T extends { rateLimit: RateLimit }>(what: string, query: string, variables: Record<string, unknown>): Promise<T> =>
    meter.add(await postWhole<T>(api, `${what} of ${request.repo}`, query, { owner, name, ...variables }));
  const pending = await readRanges(post, request);
  if (pending.tip === null) throw new Error(`backstop snapshot of ${request.repo} unreadable: no branch ${request.branch}`);
  return {
    open: await sequential(pending.open, async (pr) => ({
      number: pr.number,
      headRefOid: pr.headRefOid,
      baseRefName: pr.baseRefName,
      updatedAt: pr.updatedAt,
      head: pr.commits.nodes[0] ? await wholeContexts(post, pr.commits.nodes[0].commit) : null,
      reviews: await wholeReviews(post, pr.number, pr.reviews),
    })),
    done: pending.done.map(donePr),
    main: { tip: pending.tip, commits: await sequential(pending.commits, (commit) => wholeContexts(post, commit)) },
    rateLimit: meter.total(),
  };
}

type Post = <T extends { rateLimit: RateLimit }>(what: string, query: string, variables: Record<string, unknown>) => Promise<T>;

async function readRanges(post: Post, request: BackstopRequest): Promise<Pending> {
  const open = startRange();
  const done = startRange();
  const history = startRange();
  const doneFloor = Date.parse(request.doneSince) - DONE_OVERLAP_MS;
  const pending: Pending = { open: [], done: [], tip: null, commits: [] };
  while (open.more || done.more || history.more) {
    const variables = {
      branch: `refs/heads/${request.branch}`,
      since: request.since,
      ...pageVariables("open", open, "openAfter"),
      ...pageVariables("done", done, "doneAfter"),
      ...pageVariables("main", history, "historyAfter"),
    };
    const page = await post<GhSnapshotData>("backstop snapshot", SNAPSHOT_QUERY, { ...variables, withOpen: open.more, withDone: done.more, withHistory: history.more });
    const repository = page.repository;
    if (!repository) throw new Error(`backstop snapshot of ${request.repo} unreadable: no repository`);
    if (repository.open) pending.open.push(...advance(open, repository.open));
    if (repository.done) pending.done.push(...readDone(done, repository.done, doneFloor));
    if (repository.ref !== undefined) readHistory(pending, history, repository.ref?.target ?? null, request.mainCursor);
  }
  return pending;
}

function startRange(): Range {
  return { after: null, pages: 0, more: true };
}

/** Counts the page about to be read, and throws before reading one past the range's cap. */
function pageVariables(range: BackstopRange, state: Range, key: string): Record<string, string | null> {
  if (!state.more) return {};
  if (state.pages === BACKSTOP_CAPS[range]) throw new BackstopTruncated(range, BACKSTOP_CAPS[range]);
  state.pages += 1;
  return { [key]: state.after };
}

function advance<N>(state: Range, connection: GhConnection<N>): N[] {
  state.more = connection.pageInfo.hasNextPage;
  state.after = connection.pageInfo.endCursor;
  return connection.nodes;
}

function readDone(state: Range, connection: GhConnection<GhDonePr>, floor: number): GhDonePr[] {
  const nodes = advance(state, connection);
  const fresh = nodes.filter((pr) => Date.parse(pr.updatedAt) >= floor);
  if (fresh.length < nodes.length) state.more = false;
  return fresh;
}

function readHistory(pending: Pending, state: Range, target: GhHistoryTarget | null, cursor: string | null): void {
  if (!target) {
    state.more = false;
    return;
  }
  pending.tip ??= target.oid;
  const nodes = advance(state, target.history);
  const stop = cursor === null ? -1 : nodes.findIndex((commit) => commit.oid === cursor);
  if (stop >= 0) state.more = false;
  pending.commits.push(...(stop >= 0 ? nodes.slice(0, stop) : nodes));
}

/** A `contexts` connection with more pages is re-read for that one commit. */
async function wholeContexts(post: Post, { oid, statusCheckRollup }: GhCommit): Promise<BackstopCommit> {
  const first = statusCheckRollup?.contexts;
  const nodes = first ? [...first.nodes] : [];
  for (let next = first?.pageInfo, pages = 0; next?.hasNextPage; ) {
    if (pages === BACKSTOP_CAPS.contexts) throw new BackstopTruncated("contexts", BACKSTOP_CAPS.contexts);
    pages += 1;
    const page = await post<GhContextsData>(`contexts of ${oid}`, CONTEXTS_QUERY, { oid, after: next.endCursor });
    const contexts = page.repository?.object?.statusCheckRollup?.contexts;
    if (!contexts) throw new Error(`contexts of ${oid} unreadable: no rollup on a follow-up page`);
    nodes.push(...contexts.nodes);
    next = contexts.pageInfo;
  }
  return { oid, contexts: nodes.map(rollupContext) };
}

/** A `reviews` connection read from its newest end; earlier pages are re-read for that one PR. */
async function wholeReviews(post: Post, number: number, first: GhReviews): Promise<BackstopReview[]> {
  const nodes = [...first.nodes];
  for (let previous = first.pageInfo, pages = 0; previous.hasPreviousPage; ) {
    if (pages === BACKSTOP_CAPS.reviews) throw new BackstopTruncated("reviews", BACKSTOP_CAPS.reviews);
    pages += 1;
    const page = await post<GhReviewsData>(`reviews of #${number}`, REVIEWS_QUERY, { number, before: previous.startCursor });
    const reviews = page.repository?.pullRequest?.reviews;
    if (!reviews) throw new Error(`reviews of #${number} unreadable: no PR on a follow-up page`);
    nodes.unshift(...reviews.nodes);
    previous = reviews.pageInfo;
  }
  return nodes;
}

function rollupContext(node: GhContext): RollupContext {
  if (node.__typename === "CheckRun") return { kind: "check", databaseId: node.databaseId, name: node.name, status: node.status, conclusion: node.conclusion, completedAt: node.completedAt };
  return { kind: "status", context: node.context, state: node.state, createdAt: node.createdAt };
}

function donePr(pr: GhDonePr): BackstopDonePr {
  return { number: pr.number, merged: pr.merged, mergedBy: pr.mergedBy?.login ?? null, mergeCommit: pr.mergeCommit?.oid ?? null, closedAt: pr.closedAt, updatedAt: pr.updatedAt };
}

function rateMeter() {
  let cost = 0;
  let queries = 0;
  let last: RateLimit | null = null;
  return {
    add<T extends { rateLimit: RateLimit }>(page: T): T {
      cost += page.rateLimit.cost;
      queries += 1;
      last = page.rateLimit;
      return page;
    },
    total: (): BackstopSnapshot["rateLimit"] => ({ cost, remaining: last?.remaining ?? 0, resetAt: last?.resetAt ?? "", queries }),
  };
}

/** One query at a time, so a repo's follow-ups never burst the secondary limit. */
async function sequential<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) results.push(await map(item));
  return results;
}
