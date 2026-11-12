/** The one time shape the planner probes accept, shared by `--since` and a round's `submittedAt`. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The shape alone lets `2026-02-30T00:00:00Z` through and `Date.parse` rolls it to March, so the value must survive a round trip through a Date. */
export function isIsoTime(value: string): boolean {
  if (!ISO_TIME.test(value)) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}
