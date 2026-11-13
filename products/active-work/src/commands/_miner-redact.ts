import type { CostBucket, CostReport, OutcomeBucket } from '@titan-design/session-analytics';
import type { CommandContext } from '../registry/types.js';
import { callerVisibility, noteHiddenInitiatives } from '../sessions/visibility.js';

/**
 * Miner spend reports key buckets by initiative name. A non-owner caller gets every initiative not
 * known to be agent-visible folded into one bucket under this key, so totals still add up and no name is served
 * (TP-5556, census row 18).
 */
export const OWNER_ONLY_KEY = 'owner-only';

/** Whether a bucket key may be served to this caller by name. */
type Shown = (key: string) => boolean;

const CWD_PREFIX = 'active-work:';

/**
 * Keys that name no initiative: the cwd guesses for a repo, another directory, a temp fork or no cwd,
 * and the outcome report's bucket for a dispatch with none. Every other key is an initiative name.
 */
const NON_INITIATIVE_PREFIXES = ['repo:', 'other:'];
const NON_INITIATIVE_KEYS = new Set(['unknown', 'ac-fork(tmp)', '(none)']);

const namesNoInitiative = (key: string): boolean =>
  NON_INITIATIVE_KEYS.has(key) || NON_INITIATIVE_PREFIXES.some((prefix) => key.startsWith(prefix));

/** A session's initiative is a slug, or `active-work:<slug>` when it was guessed from the cwd. */
const slugOf = (key: string): string => (key.startsWith(CWD_PREFIX) ? key.slice(CWD_PREFIX.length) : key);

function fold<T extends { key: string }>(rows: readonly T[], shown: Shown, merge: (a: T, b: T) => T): T[] {
  const kept = rows.filter((row) => shown(row.key));
  const folded = rows.filter((row) => !shown(row.key));
  if (folded.length === 0) return kept;
  const [first, ...rest] = folded;
  return [...kept, rest.reduce(merge, { ...first, key: OWNER_ONLY_KEY })];
}

const sumCost = (a: CostBucket, b: CostBucket): CostBucket => ({
  key: a.key,
  requests: a.requests + b.requests,
  sessions: a.sessions + b.sessions,
  costUsd: a.costUsd + b.costUsd,
});

type InitiativeSpend = Pick<CostReport, 'byInitiative' | 'topSessions'>;

export function redactCostReport<T extends InitiativeSpend>(report: T, shown: Shown): T {
  return {
    ...report,
    byInitiative: fold(report.byInitiative, shown, sumCost),
    topSessions: report.topSessions.map((row) =>
      shown(row.initiative) ? row : { ...row, initiative: OWNER_ONLY_KEY },
    ),
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

export function redactOutcomeReport<T extends { byInitiative: OutcomeBucket[] }>(report: T, shown: Shown): T {
  return { ...report, byInitiative: fold(report.byInitiative, shown, sumOutcome) };
}

/**
 * An allow list, since the keys come from the session graph's history, not the live root: an archived,
 * renamed or unlisted initiative is withheld from a non-owner, and an unreadable root withholds every one.
 * The count of withheld initiatives is noted as a warning.
 */
export async function minerShownKeys(
  ctx: Pick<CommandContext, 'activeRoot' | 'caller' | 'warnings'>,
  keys: readonly string[],
): Promise<Shown> {
  const visible = await callerVisibility(ctx.activeRoot, ctx.caller);
  const shown: Shown = (key) => namesNoInitiative(key) || visible(slugOf(key));
  noteHiddenInitiatives(ctx.warnings, new Set(keys.filter((key) => !shown(key)).map(slugOf)).size);
  return shown;
}
