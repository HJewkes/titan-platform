/**
 * A churn window is either a rolling N-day window or `"lifetime"` = all of git
 * history (no `--since` bound). Lifetime mode lets an unfamiliar repo be audited
 * cold, where any recent rolling slice is thin relative to the repo's whole
 * life, so a windowed view reads an established repo as nearly churn-free.
 */
export type ChurnWindow = number | "lifetime";

export const DAY_SECONDS = 86400;

/** Lower bound (epoch seconds) of a finite window ending at `nowEpoch`. */
export function windowCutoff(windowDays: number, nowEpoch: number): number {
  return nowEpoch - windowDays * DAY_SECONDS;
}
