/** How many of the ascending `sortedMs` are at or before `targetMs`, by binary search. */
export function countAtOrBefore(sortedMs: readonly number[], targetMs: number): number {
  let lo = 0;
  let hi = sortedMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sortedMs[mid] as number) <= targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
