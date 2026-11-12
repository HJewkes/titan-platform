import type { PrDue, PrResolution, PrResolver, ResolvedPr } from '@titan-design/session-graph';
import { z } from 'zod';

import { runCommand, type RunCommand } from '../utils/run-command.js';

/**
 * Resolve PR outcomes against GitHub through `gh` (TP-275, design G8).
 *
 * A transcript only sees a merge it ran itself; a merge done in the browser or
 * by another session, a close, and the review history exist only on the forge.
 * `@titan-design/session-graph` takes this as its `PrResolver` and decides which PRs are due and in what
 * order (`prsNeedingOutcome`). This side only throttles: it skips a PR inside its failure backoff or, for a
 * `recheck` PR, inside its recheck interval, caps the rest per pass, and turns every `gh` failure into an error
 * line rather than a thrown pass: the PR is left out of the resolution, so its
 * row stays unchecked and the next pass asks again.
 */

const PR_OUTCOME_BATCH = 50;
const CONCURRENCY = 5;
const DEFAULT_FAIL_BACKOFF_MS = 30 * 60 * 1000;
const DEFAULT_OPEN_RECHECK_MS = 10 * 60 * 1000;
const DEFAULT_CLOSED_RECHECK_MS = 24 * 60 * 60 * 1000;
const GH_FIELDS = 'state,mergedAt,closedAt,reviews,commits';

interface PrOutcomeOptions {
  /** Process boundary; tests replace it so the real `gh` never runs. */
  run?: RunCommand;
  /** PRs asked about per pass. */
  limit?: number;
  /** Receives one line per PR `gh` could not answer. */
  errors?: string[];
  /** Least time between two checks of one open PR; `AW_PR_OPEN_RECHECK_MS` sets the default. */
  openRecheckMs?: number;
  /** Least time before a closed PR is checked again, so a reopen is seen; `AW_PR_CLOSED_RECHECK_MS`. */
  closedRecheckMs?: number;
  /** Clock for the failure backoff and the recheck intervals; tests replace it. */
  now?: () => number;
  /** Told how many PRs each call asks `gh` about, so the pass log can carry it. */
  onPolled?: (count: number) => void;
}

/** Failure times outlive a resolver: each refresh pass builds a new one inside one daemon. */
const failedAt = new Map<string, number>();

export function clearPrFailureBackoff(): void {
  failedAt.clear();
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const failBackoffMs = (): number => envMs('AW_PR_FAIL_BACKOFF_MS', DEFAULT_FAIL_BACKOFF_MS);

interface RecheckIntervals {
  open: number;
  closed: number;
}

function recheckIntervals(options: PrOutcomeOptions): RecheckIntervals {
  return {
    open: options.openRecheckMs ?? envMs('AW_PR_OPEN_RECHECK_MS', DEFAULT_OPEN_RECHECK_MS),
    closed: options.closedRecheckMs ?? envMs('AW_PR_CLOSED_RECHECK_MS', DEFAULT_CLOSED_RECHECK_MS),
  };
}

/** A `recheck` PR is due once its state's interval has passed since the last check. */
function isDue(pr: PrDue, now: number, every: RecheckIntervals): boolean {
  const checked = Date.parse(pr.checkedAt ?? '');
  if (Number.isNaN(checked)) return true;
  const interval = pr.state?.toLowerCase() === 'open' ? every.open : every.closed;
  return now - checked >= interval;
}

/** A wrong-typed field fails the parse, which the caller reports like any other `gh` failure. */
const GhPrSchema = z.looseObject({
  state: z.string().nullish(),
  mergedAt: z.string().nullish(),
  closedAt: z.string().nullish(),
  reviews: z
    .array(z.looseObject({ state: z.string().nullish(), submittedAt: z.string().nullish() }))
    .nullish(),
  commits: z.array(z.looseObject({ committedDate: z.string().nullish() })).nullish(),
});

type GhPr = z.infer<typeof GhPrSchema>;

/** The round rule lives in session-graph; this side only hands over what the forge said. */
function toResolved(pr: GhPr): ResolvedPr {
  return {
    state: pr.state ?? null,
    mergedAt: pr.mergedAt || null,
    closedAt: pr.closedAt || null,
    reviews: (pr.reviews ?? []).flatMap((r) =>
      r.state && r.submittedAt ? [{ state: r.state, submittedAt: r.submittedAt }] : [],
    ),
    // Sent even when empty, so the package stores [] instead of offering the PR again.
    commitTimes: (pr.commits ?? []).flatMap((c) => (c.committedDate ? [c.committedDate] : [])),
  };
}

/**
 * Throttling only; session-graph's `prsNeedingOutcome` already decided which PRs are due and their order.
 * A PR that failed recently waits out the backoff. A `recheck` PR waits out its state's interval (short for
 * open, long for closed so a reopen is seen). `unchecked` and `backfill` PRs are asked at once: one answer
 * settles a backfill PR, since it always carries commit times.
 */
function selectPrs(prs: readonly PrDue[], limit: number, now: number, every: RecheckIntervals): PrDue[] {
  const backoff = failBackoffMs();
  const inBackoff = (pr: PrDue): boolean => {
    const failed = failedAt.get(pr.prRef);
    return failed !== undefined && now - failed <= backoff;
  };
  return prs
    .filter((pr) => !inBackoff(pr) && (pr.band !== 'recheck' || isDue(pr, now, every)))
    .slice(0, limit);
}

async function viewPr(run: RunCommand, pr: PrDue): Promise<ResolvedPr> {
  const args = ['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', GH_FIELDS];
  const result = await run('gh', args);
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n')[0] || `exit ${String(result.code)}`;
    throw new Error(reason);
  }
  const parsed = GhPrSchema.safeParse(JSON.parse(result.stdout));
  if (!parsed.success) {
    const at = parsed.error.issues[0]?.path.join('.') || 'top level';
    throw new Error(`unexpected gh pr view output at ${at}`);
  }
  return toResolved(parsed.data);
}

export function ghPrResolver(options: PrOutcomeOptions = {}): PrResolver {
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const every = recheckIntervals(options);
  return async (prs: readonly PrDue[]): Promise<PrResolution> => {
    const queue = selectPrs(prs, options.limit ?? PR_OUTCOME_BATCH, now(), every);
    options.onPolled?.(queue.length);
    const resolved = new Map<string, ResolvedPr>();
    const worker = async (): Promise<void> => {
      for (let pr = queue.shift(); pr; pr = queue.shift()) {
        try {
          resolved.set(pr.prRef, await viewPr(run, pr));
          failedAt.delete(pr.prRef);
        } catch (err) {
          failedAt.set(pr.prRef, now());
          const reason = err instanceof Error ? err.message : String(err);
          options.errors?.push(`prs: ${pr.repo}#${String(pr.number)}: ${reason}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return resolved;
  };
}
