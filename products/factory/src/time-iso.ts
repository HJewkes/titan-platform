/** Wall-clock reads and ISO-8601 conversion for recipe files, which may not name the `Date` global themselves. */

/** Milliseconds since the epoch; resolves `Date.now` at each call so fake timers apply. */
export const wallClock = (): number => Date.now();

/** Milliseconds for an ISO-8601 string; NaN when it does not parse. */
export const parseIsoMs = (iso: string): number => Date.parse(iso);

/** The ISO-8601 string for a millisecond timestamp. */
export const isoAt = (ms: number): string => new Date(ms).toISOString();
