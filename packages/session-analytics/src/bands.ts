/** Half-open [lo, hi) in the band's own unit. */
export interface Band {
  lo: number;
  hi: number;
  name: string;
}

/** Context size in tokens. From `cf_analyze.py` BANDS. */
export const CONTEXT_BANDS: readonly Band[] = [
  { lo: 0, hi: 50_000, name: "<50k" },
  { lo: 50_000, hi: 100_000, name: "50-100k" },
  { lo: 100_000, hi: 200_000, name: "100-200k" },
  { lo: 200_000, hi: Number.POSITIVE_INFINITY, name: "200k+" },
];

/** Idle gap in milliseconds. From `cf_analyze.py` IDLE. */
export const GAP_BANDS: readonly Band[] = [
  { lo: 0, hi: 5 * 60_000, name: "<5m" },
  { lo: 5 * 60_000, hi: 60 * 60_000, name: "5-60m" },
  { lo: 60 * 60_000, hi: Number.POSITIVE_INFINITY, name: ">60m" },
];

/** Null for a value no band covers, so a caller reports the gap instead of inventing one. */
export function bandOf(value: number, bands: readonly Band[]): string | null {
  for (const band of bands) {
    if (value >= band.lo && value < band.hi) return band.name;
  }
  return null;
}

export function contextBand(tokens: number): string | null {
  return bandOf(tokens, CONTEXT_BANDS);
}

export function gapBand(millis: number): string | null {
  return bandOf(millis, GAP_BANDS);
}
