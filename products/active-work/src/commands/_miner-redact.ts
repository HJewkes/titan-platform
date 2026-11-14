import type { CostBucket, CostReport, OutcomeBucket } from '@titan-design/session-analytics';
import type { CommandContext } from '../registry/types.js';
import { visibilityFor, withheldSlugs } from '../sessions/visibility.js';

/**
 * Miner spend reports key buckets by initiative name. A non-owner caller gets every initiative not
 * shown to agents folded into one bucket under this key, so totals still add up and no name is served
 * (TP-5556, census row 18).
 */
export const OWNER_ONLY_KEY = 'owner-only';

/**
 * A cwd outside any repo or `active-work/` path is keyed `other:<basename>`, and that basename can be
 * an owner-only slug when the active root has another name (TP-5748, TP-5749). A non-owner gets such
 * keys collapsed into this one.
 */
const OTHER_KEY = 'other';
const OTHER_PREFIX = `${OTHER_KEY}:`;

/** Keys that name no initiative and are served as they are: a repo, a temp fork, no cwd, no dispatch. */
const UNKNOWN_KEY = 'unknown';
const NON_INITIATIVE_KEYS = new Set([UNKNOWN_KEY, 'ac-fork(tmp)', '(none)', OTHER_KEY]);
const REPO_PREFIX = 'repo:';

/**
 * Slugs `active-work new` refuses, since an initiative so named would pass as a non-initiative key
 * and be served to a non-owner by name (TP-5750).
 */
export const RESERVED_MINER_KEYS: ReadonlySet<string> = new Set([UNKNOWN_KEY, OTHER_KEY, OWNER_ONLY_KEY]);

/** The key a bucket is served under to this caller. */
type MinerKey = (key: string) => string;

const CWD_PREFIX = 'active-work:';

/** A session's initiative is a slug, or `active-work:<slug>` when it was guessed from the cwd. */
const slugOf = (key: string): string => (key.startsWith(CWD_PREFIX) ? key.slice(CWD_PREFIX.length) : key);

/** Buckets that end up under one key are merged; the owner-only bucket goes last. */
function fold<T extends { key: string }>(rows: readonly T[], keyFor: MinerKey, merge: (a: T, b: T) => T): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const key = keyFor(row.key);
    const seen = byKey.get(key);
    byKey.set(key, seen ? merge(seen, row) : { ...row, key });
  }
  const withheld = byKey.get(OWNER_ONLY_KEY);
  byKey.delete(OWNER_ONLY_KEY);
  return withheld ? [...byKey.values(), withheld] : [...byKey.values()];
}

const sumCost = (a: CostBucket, b: CostBucket): CostBucket => ({
  key: a.key,
  requests: a.requests + b.requests,
  sessions: a.sessions + b.sessions,
  costUsd: a.costUsd + b.costUsd,
});

type InitiativeSpend = Pick<CostReport, 'byInitiative' | 'topSessions'>;

export function redactCostReport<T extends InitiativeSpend>(report: T, keyFor: MinerKey): T {
  return {
    ...report,
    byInitiative: fold(report.byInitiative, keyFor, sumCost),
    topSessions: report.topSessions.map((row) => ({ ...row, initiative: keyFor(row.initiative) })),
  };
}

/** The same rates `costPerOutcome` gives a bucket, recomputed over the folded sums. */
function withRates(bucket: OutcomeBucket): OutcomeBucket {
  const per = (n: number): number | null => (n > 0 ? bucket.costUsd / n : null);
  const finished = bucket.merged + bucket.done;
  return {
    ...bucket,
    usdPerMerged: per(bucket.merged),
    usdPerDone: per(bucket.done),
    requestsPerFinished: finished > 0 ? bucket.requests / finished : null,
  };
}

const sumOutcome = (a: OutcomeBucket, b: OutcomeBucket): OutcomeBucket =>
  withRates({
    ...a,
    assignments: a.assignments + b.assignments,
    merged: a.merged + b.merged,
    done: a.done + b.done,
    costUsd: a.costUsd + b.costUsd,
    requests: a.requests + b.requests,
  });

type OutcomeNames = { bySeat: OutcomeBucket[]; seatCostUsd: { key: string; costUsd: number }[]; unmatchedAgents: string[] };

/**
 * Seat and agent names are free-form, so one can carry an owner-only initiative slug (`<slug>-coord`).
 * A name holding a withheld slug as a whole hyphen-delimited token run is served as the owner-only key.
 */
export function redactOutcomeReport<T extends { byInitiative: OutcomeBucket[] } & OutcomeNames>(
  report: T,
  keyFor: MinerKey,
  nameFor: MinerKey,
): T {
  const unmatched = [...new Set(report.unmatchedAgents.map(nameFor))];
  const withheld = unmatched.includes(OWNER_ONLY_KEY);
  return {
    ...report,
    byInitiative: fold(report.byInitiative, keyFor, sumOutcome),
    bySeat: fold(report.bySeat, nameFor, sumOutcome),
    seatCostUsd: fold(report.seatCostUsd, nameFor, (a, b) => ({ key: a.key, costUsd: a.costUsd + b.costUsd })),
    unmatchedAgents: withheld ? [...unmatched.filter((name) => name !== OWNER_ONLY_KEY), OWNER_ONLY_KEY] : unmatched,
  };
}

/**
 * The keys come from the session graph's history, not the live root, so `visibilityFor`'s allow list
 * withholds an archived, renamed or unlisted initiative from a non-owner, and every one under an
 * unreadable root. An `other:` key keeps its basename only when that is itself a shown initiative, so
 * the owner, who is shown everything, gets every key as it is.
 */
export async function minerKeys(ctx: Pick<CommandContext, 'activeRoot' | 'caller' | 'warnings'>): Promise<MinerKey> {
  const shown = await visibilityFor(ctx);
  return (key) => {
    if (key.startsWith(OTHER_PREFIX)) return shown(key.slice(OTHER_PREFIX.length)) ? key : OTHER_KEY;
    if (NON_INITIATIVE_KEYS.has(key) || key.startsWith(REPO_PREFIX)) return key;
    return shown(slugOf(key)) ? key : OWNER_ONLY_KEY;
  };
}

const hasSlugTokens = (name: string, slug: string): boolean =>
  name.split(/[^A-Za-z0-9-]+/).some((word) => `-${word}-`.includes(`-${slug}-`));

/**
 * The name a seat or agent is served under. `withheldSlugs` lists only initiatives on disk now, so a
 * slug that has left the root cannot be matched here; the owner, shown everything, has none withheld.
 */
export async function minerNames(ctx: Pick<CommandContext, 'activeRoot' | 'caller' | 'warnings'>): Promise<MinerKey> {
  const shown = await visibilityFor(ctx);
  const withheld = (await withheldSlugs(ctx.activeRoot)).filter((slug) => !shown(slug));
  return (name) => (withheld.some((slug) => hasSlugTokens(name, slug)) ? OWNER_ONLY_KEY : name);
}
