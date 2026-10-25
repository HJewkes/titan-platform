/** How much larger each rung of the ladder is than the one before. */
export const GROWTH = 4;
/**
 * The largest ratio a linear operation may show. A run at a size GROWTH times larger is counted against GROWTH runs at
 * the smaller size: at most the same work when linear (a ratio near 1, or below it where a fixed cost dominates), GROWTH
 * times more when quadratic, far more for a backtracking matcher. Counts are the same on every machine and under any
 * load, so the limit needs no room for noise.
 */
export const LINEAR_WORK_LIMIT = 2;

export interface WorkOptions {
  /** The first size; each rung multiplies it by GROWTH until it would pass `to`. */
  from: number;
  /** The largest size counted when every rung below it stays under the limit. */
  to: number;
  /** A running total of the work done so far, such as fix-proof's `linearRegExpSteps`; read before and after each run. */
  meter: () => number;
  /**
   * The smallest size whose rung is judged on its ratio; smaller rungs must only be counted. A pattern of m states can
   * hold more of them live with each character until the input is about m long, which reads as growth below that size.
   * Defaults to `from`.
   */
  steady?: number;
}

export interface WorkGrowth {
  /** The worst ratio seen; at or past LINEAR_WORK_LIMIT the ladder stopped there. Infinity when the meter saw no work. */
  ratio: number;
  /** The larger size of the rung that gave `ratio`. */
  size: number;
}

/**
 * Climbs sizes `from`, `from * GROWTH`, ... up to `to`, and at each rung compares the work `meter` counts for one run of
 * the larger size with GROWTH runs of the smaller. It stops at the first rung whose ratio reaches LINEAR_WORK_LIMIT,
 * before trying a larger size, so a polynomial walk fails on a small input instead of hanging on the large one. A run
 * the meter counts nothing for gives Infinity at once: the operation no longer goes through the counted engine, as when
 * a matcher falls back to a backtracking RegExp. Assert `ratio` below LINEAR_WORK_LIMIT in the test (TP-4262).
 */
export function linearWork(prepare: (size: number) => () => void, options: WorkOptions): WorkGrowth {
  const worst: WorkGrowth = { ratio: 0, size: options.from };
  for (let size = options.from; size * GROWTH <= options.to; size *= GROWTH) {
    const ratio = rungRatio(prepare, size, options);
    if (ratio > worst.ratio) Object.assign(worst, { ratio, size: size * GROWTH });
    if (ratio >= LINEAR_WORK_LIMIT) break;
  }
  return worst;
}

/** The rung's ratio, or 0 for a counted rung below `steady`. */
function rungRatio(prepare: (size: number) => () => void, size: number, { meter, steady }: WorkOptions): number {
  const small = counted(prepare(size), meter);
  if (small === 0) return Infinity;
  const large = counted(prepare(size * GROWTH), meter);
  if (large === 0) return Infinity;
  return size < (steady ?? 0) ? 0 : large / (GROWTH * small);
}

function counted(run: () => void, meter: () => number): number {
  const before = meter();
  run();
  return meter() - before;
}
