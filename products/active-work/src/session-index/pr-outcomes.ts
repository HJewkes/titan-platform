import type { PrKey, PrResolution, PrResolver, ResolvedPr } from '@titan-design/session-graph';
import { z } from 'zod';

import { runCommand, type RunCommand } from '../utils/run-command.js';
import type { WorkspaceGraph } from './graph.js';

/**
 * Resolve PR outcomes against GitHub through `gh` (TP-275, design G8).
 *
 * A transcript only sees a merge it ran itself; a merge done in the browser or
 * by another session, a close, and the review history exist only on the forge.
 * `@titan-design/session-graph` takes this as its `PrResolver` and hands it
 * every PR not yet known to be merged. This side narrows that to what can
 * still change, caps it per pass, and turns every `gh` failure into an error
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

/** A checked PR is due once its state's interval has passed. */
function isDue(row: CheckedRow, now: number, every: RecheckIntervals): boolean {
  const checked = Date.parse(row.outcome_checked_at ?? '');
  if (Number.isNaN(checked)) return true;
  const interval = row.state?.toLowerCase() === 'open' ? every.open : every.closed;
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

interface CheckedRow {
  pr_ref: string;
  state: string | null;
  outcome_checked_at: string | null;
  commit_times: string | null;
}

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

/** Bands match session-graph's PRS_NEEDING_OUTCOME, so a cap cannot starve open PRs behind backfill. */
function byPollingOrder(byRef: ReadonlyMap<string, CheckedRow>): (a: PrKey, b: PrKey) => number {
  const band = (pr: PrKey): number => {
    const row = byRef.get(pr.prRef);
    if (!row?.outcome_checked_at) return 0;
    return row.state?.toLowerCase() === 'merged' ? 2 : 1;
  };
  const checkedAt = (pr: PrKey): string => byRef.get(pr.prRef)?.outcome_checked_at ?? '';
  return (a, b) =>
    band(a) - band(b) ||
    checkedAt(a).localeCompare(checkedAt(b)) ||
    a.prRef.localeCompare(b.prRef);
}

/**
 * The package re-asks a checked PR until it is merged, which would re-query
 * every PR each pass. A never-checked PR is always asked, since a transcript-seen
 * merge is unchecked until the forge confirms it. A checked merged PR is final
 * once its commit times are stored; with them missing the package offers it, and
 * one answer fills them (an empty list counts), so it is asked once. Any other PR is asked again only
 * after its recheck interval (short for open, long for closed so a reopen is
 * seen), and the least recently checked go first so a long tail is not
 * starved by the same fifty.
 */
function selectPrs(
  graph: WorkspaceGraph,
  prs: readonly PrKey[],
  limit: number,
  now: number,
  every: RecheckIntervals,
): PrKey[] {
  const backoff = failBackoffMs();
  const rows = graph.db
    .prepare<[], CheckedRow>('SELECT pr_ref, state, outcome_checked_at, commit_times FROM pr')
    .all();
  const byRef = new Map(rows.map((row) => [row.pr_ref, row]));
  return prs
    .filter((pr) => {
      const failed = failedAt.get(pr.prRef);
      if (failed !== undefined && now - failed <= backoff) return false;
      const row = byRef.get(pr.prRef);
      if (!row?.outcome_checked_at) return true;
      if (row.state?.toLowerCase() === 'merged') return row.commit_times === null;
      return isDue(row, now, every);
    })
    .sort(byPollingOrder(byRef))
    .slice(0, limit);
}

async function viewPr(run: RunCommand, pr: PrKey): Promise<ResolvedPr> {
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

export function ghPrResolver(graph: WorkspaceGraph, options: PrOutcomeOptions = {}): PrResolver {
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const every = recheckIntervals(options);
  return async (prs: readonly PrKey[]): Promise<PrResolution> => {
    const queue = selectPrs(graph, prs, options.limit ?? PR_OUTCOME_BATCH, now(), every);
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
