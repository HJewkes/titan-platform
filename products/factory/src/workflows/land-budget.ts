/** Updates a strict repo always gets before the time budget can stop the run, however fast they came. */
export const MAX_UPDATE_CYCLES = 3;

/**
 * How long a strict repo keeps chasing a moving base, from the first update since the last human gate. Main moves
 * about every 25 minutes and CI can take 20 under load, so a fixed count ran out while the PR was a normal race.
 */
export const UPDATE_BUDGET_MS = 120 * 60_000;

export interface UpdateBound {
  sinceGate: number;
  /** The heads each of those updates started from, so a stuck-behind gate names them. */
  from: string[];
  /** When the first of those updates ran; absent when none has, or when it ran before updates recorded a time. */
  startedAt?: number;
}

export function newUpdateBound(): UpdateBound {
  return { sinceGate: 0, from: [] };
}

/** Only a human answer restarts the update count; an allow per head must not let a racing base loop unasked. */
export function resetBound(bound: UpdateBound): void {
  bound.sinceGate = 0;
  bound.from = [];
  delete bound.startedAt;
}

export function recordUpdate(bound: UpdateBound, fromSha: string, at: number | undefined): void {
  if (bound.sinceGate === 0 && at !== undefined) bound.startedAt = at;
  bound.sinceGate += 1;
  bound.from.push(fromSha);
}

/** Recorded steps from before updates carried a time have no elapsed time, so they keep the fixed count they ran under. */
function elapsedMs(bound: UpdateBound, readAt: number | undefined): number | undefined {
  if (bound.startedAt === undefined || readAt === undefined) return undefined;
  return readAt - bound.startedAt;
}

export function budgetSpent(bound: UpdateBound, readAt: number | undefined): boolean {
  if (bound.sinceGate < MAX_UPDATE_CYCLES) return false;
  const elapsed = elapsedMs(bound, readAt);
  return elapsed === undefined || elapsed >= UPDATE_BUDGET_MS;
}

/** The base kept moving while each updated head's CI ran; the owner sees every head the updates started from, and for how long. */
export function stuckBehindReason(bound: UpdateBound, headSha: string, readAt: number | undefined): string {
  const heads = [...bound.from, headSha].map((sha) => sha.slice(0, 7)).join(" -> ");
  const elapsed = elapsedMs(bound, readAt);
  const time = elapsed === undefined ? "" : ` over ${Math.round(elapsed / 60_000)} min (budget ${UPDATE_BUDGET_MS / 60_000} min)`;
  return `still behind its base after ${bound.sinceGate} updates${time}, heads ${heads}`;
}

/**
 * How long a strict behind head waits on a required check that has not reported at all, from the head's first `ci-wait`
 * read. A workflow that exists only on the base never reports on the old head, and only the update starts it.
 */
export const MISSING_CHECK_GRACE_MS = 10 * 60_000;

/** When each head was first read by `ci-wait`; an in-process map, so a restarted step grants a fresh grace. */
export type FirstReads = Map<string, number>;

/** True once the head has been read for at least `graceMs`; the first read of a head starts its clock. */
export function missingCheckGraceSpent(firstReads: FirstReads, headKey: string, now: number, graceMs: number): boolean {
  if (!firstReads.has(headKey)) firstReads.set(headKey, now);
  return now - firstReads.get(headKey)! >= graceMs;
}
