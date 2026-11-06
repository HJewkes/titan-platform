/** ISO-8601 conversion for recipe files, which may not name the `Date` global themselves. Pure: it never reads the clock. */

/** Milliseconds for an ISO-8601 string; NaN when it does not parse. */
export const parseIsoMs = (iso: string): number => Date.parse(iso);

/** The ISO-8601 string for a millisecond timestamp. */
export const isoAt = (ms: number): string => new Date(ms).toISOString();
