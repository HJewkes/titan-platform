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

/**
 * `git log` arguments bounding a window: none for lifetime, a cutoff at `untilEpoch`
 * when given, else relative to the wall clock.
 */
export function sinceArgs(windowDays: ChurnWindow, untilEpoch?: number): string[] {
  if (windowDays === "lifetime") return [];
  if (untilEpoch === undefined) return [`--since=${windowDays}.days.ago`];
  return [`--since=@${windowCutoff(windowDays, untilEpoch)}`];
}

/** The rev to walk from, terminated by `--` so it never reads as a path; none walks from HEAD. */
export function revArgs(rev?: string): string[] {
  return rev === undefined ? [] : [rev, "--"];
}
