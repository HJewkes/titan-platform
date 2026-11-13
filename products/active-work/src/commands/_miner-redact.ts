import type { CostPerOutcomeReport, CostReport, OutcomeBucket } from '@titan-design/session-analytics';
import type { CommandContext } from '../registry/types.js';
import { hiddenSlugsForCaller, noteHiddenInitiatives } from '../sessions/visibility.js';

/**
 * Miner spend reports key buckets by initiative name. A non-owner caller gets every owner-only
 * initiative folded into one bucket under this key, so totals still add up and no name is served
 * (TP-5556, census row 18).
 */
export const OWNER_ONLY_KEY = 'owner-only';

type Hidden = ReadonlySet<string>;

const CWD_PREFIX = 'active-work:';

/** A session's initiative is a slug, or `active-work:<slug>` when it was guessed from the cwd. */
const slugOf = (key: string): string => (key.startsWith(CWD_PREFIX) ? key.slice(CWD_PREFIX.length) : key);

function namesHidden(key: string | null, hidden: Hidden): boolean {
  return key !== null && hidden.has(slugOf(key));
}

function hiddenNamed(keys: readonly (string | null)[], hidden: Hidden): number {
  return new Set(keys.filter((key) => namesHidden(key, hidden)).map((key) => slugOf(key!))).size;
}

function fold<T extends { key: string | null }>(rows: readonly T[], hidden: Hidden, merge: (a: T, b: T) => T): T[] {
  const kept = rows.filter((row) => !namesHidden(row.key, hidden));
  const folded = rows.filter((row) => namesHidden(row.key, hidden));
  if (folded.length === 0) return kept;
  const [first, ...rest] = folded;
  return [...kept, rest.reduce(merge, { ...first!, key: OWNER_ONLY_KEY })];
}

type CostBucket = CostReport['byInitiative'][number];

const sumCost = (a: CostBucket, b: CostBucket): CostBucket => ({
  key: a.key,
  requests: a.requests + b.requests,
  sessions: a.sessions + b.sessions,
  costUsd: a.costUsd + b.costUsd,
});

export function redactCostReport(report: CostReport, hidden: Hidden): CostReport {
  return {
    ...report,
    byInitiative: fold(report.byInitiative, hidden, sumCost),
    topSessions: report.topSessions.map((row) =>
      namesHidden(row.initiative, hidden) ? { ...row, initiative: OWNER_ONLY_KEY } : row,
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

export function redactOutcomeReport<T extends CostPerOutcomeReport>(report: T, hidden: Hidden): T {
  return { ...report, byInitiative: fold(report.byInitiative, hidden, sumOutcome) };
}

/** The owner-only names this caller may not see, with the count noted as a warning when any appear. */
export async function minerHiddenSlugs(
  ctx: Pick<CommandContext, 'activeRoot' | 'caller' | 'warnings'>,
  keys: readonly (string | null)[],
): Promise<Hidden> {
  const hidden = await hiddenSlugsForCaller(ctx.activeRoot, ctx.caller);
  noteHiddenInitiatives(ctx.warnings, hiddenNamed(keys, hidden));
  return hidden;
}
