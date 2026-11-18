export interface Interval {
  startS: number;
  endS: number;
}

/** One beat of an `explainer.words/v1` file: its absolute start and its words relative to it. */
export interface BeatWords {
  startS: number;
  words: readonly { start: number; end: number }[];
}

export interface DuckParams {
  /** Words closer than this share one speech run. */
  mergeGapS: number;
  attackS: number;
  releaseS: number;
  /** Bed level between speech runs. */
  gapDb: number;
  /** Bed level under speech. */
  underDb: number;
}

export const DEFAULT_DUCK: DuckParams = { mergeGapS: 0.35, attackS: 0.12, releaseS: 0.4, gapDb: -14, underDb: -26 };

/** Speech runs on the absolute clock: words merged under `mergeGapS`, then widened by attack and release. */
export function speechIntervals(beats: readonly BeatWords[], params: DuckParams = DEFAULT_DUCK): Interval[] {
  const words = beats
    .flatMap((beat) => beat.words.map((w) => ({ startS: beat.startS + w.start, endS: beat.startS + w.end })))
    .sort((a, b) => a.startS - b.startS);
  const runs = mergeWhere(words, (prev, next) => next.startS - prev.endS < params.mergeGapS);
  const widened = runs.map((r) => ({ startS: Math.max(0, r.startS - params.attackS), endS: r.endS + params.releaseS }));
  return mergeWhere(widened, (prev, next) => next.startS <= prev.endS);
}

function mergeWhere(sorted: readonly Interval[], joins: (prev: Interval, next: Interval) => boolean): Interval[] {
  const out: Interval[] = [];
  for (const next of sorted) {
    const prev = out[out.length - 1];
    if (prev && joins(prev, next)) prev.endS = Math.max(prev.endS, next.endS);
    else out.push({ ...next });
  }
  return out;
}

/**
 * The bed's gain in dB at `tS`: `underDb` inside a run, `gapDb` outside, with linear ramps over the first
 * `attackS` and last `releaseS` of each run.
 */
export function duckGainDb(intervals: readonly Interval[], tS: number, params: DuckParams = DEFAULT_DUCK): number {
  const run = intervals.find((r) => tS >= r.startS && tS <= r.endS);
  if (!run) return params.gapDb;
  const depth = params.gapDb - params.underDb;
  const down = Math.min(1, (tS - run.startS) / params.attackS);
  const up = Math.min(1, (run.endS - tS) / params.releaseS);
  return params.gapDb - depth * Math.min(down, up);
}
