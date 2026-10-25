/** How much larger each rung of the ladder is than the one before. */
export const GROWTH = 4;
/**
 * The largest ratio a linear operation should show. One run at a size GROWTH times larger is timed against GROWTH runs
 * at the smaller size: the same work when linear (a ratio near 1), GROWTH times more when quadratic, far more for the
 * polynomial backtracking of a RegExp glob.
 */
export const LINEAR_GROWTH_LIMIT = 2.5;

const RUNS = 7;
const MIN_BATCH_MS = 2;
const MAX_REPS = 1 << 16;

export interface GrowthOptions {
  /** The first size; each rung multiplies it by GROWTH until it would pass `to`. */
  from: number;
  /** The largest size measured when every rung below it stays under the limit. */
  to: number;
  /** Starts a stopwatch; calling the result gives the milliseconds since. Defaults to this thread's CPU time. */
  stopwatch?: () => () => number;
  /** Runs between timed batches, for a caller that checks a CPU budget there. */
  between?: () => void;
}

export interface Growth {
  /** The worst ratio seen; at or past LINEAR_GROWTH_LIMIT the ladder stopped there. */
  ratio: number;
  /** The larger size of the rung that gave `ratio`. */
  size: number;
}

const threadCpu = (): (() => number) => {
  const start = process.threadCpuUsage();
  return () => {
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / 1000;
  };
};

/**
 * Climbs sizes `from`, `from * GROWTH`, ... up to `to`, and at each rung compares one run of the larger size with GROWTH
 * runs of the smaller (best of seven, interleaved, so lasting contention slows both sides alike). It stops at the first
 * rung whose ratio reaches LINEAR_GROWTH_LIMIT, before trying a larger size, so a polynomial matcher fails on a small
 * input in milliseconds instead of hanging on the large one. Assert `ratio` below LINEAR_GROWTH_LIMIT in the test.
 */
export function linearGrowth(prepare: (size: number) => () => void, options: GrowthOptions): Growth {
  const worst: Growth = { ratio: 0, size: options.from };
  for (let size = options.from; size * GROWTH <= options.to; size *= GROWTH) {
    const ratio = rungRatio(prepare(size), prepare(size * GROWTH), options);
    if (ratio > worst.ratio) Object.assign(worst, { ratio, size: size * GROWTH });
    if (ratio >= LINEAR_GROWTH_LIMIT) break;
  }
  return worst;
}

function rungRatio(small: () => void, large: () => void, options: GrowthOptions): number {
  const stopwatch = options.stopwatch ?? threadCpu;
  const timed = (run: () => void): number => {
    const elapsed = stopwatch();
    run();
    return elapsed();
  };
  const reps = repsFor(small, timed);
  const smallBatch = () => repeat(small, reps * GROWTH);
  // Single large runs first: a backtracking matcher already shows its growth there, and timing a whole batch of it could take minutes.
  const probe = Math.min(...[0, 1, 2].map(() => timed(large) / (timed(smallBatch) / reps)));
  if (probe >= LINEAR_GROWTH_LIMIT * GROWTH) return probe;
  const largeBatch = () => repeat(large, reps);
  const best = { small: Infinity, large: Infinity };
  for (let run = 0; run < RUNS; run += 1) {
    best.small = Math.min(best.small, timed(smallBatch));
    best.large = Math.min(best.large, timed(largeBatch));
    options.between?.();
  }
  return best.large / Math.max(best.small, 0.001);
}

/** Enough repetitions that GROWTH of them at the small size take MIN_BATCH_MS, so a microsecond run still reads above the clock's noise. */
function repsFor(small: () => void, timed: (run: () => void) => number): number {
  let reps = 1;
  while (reps < MAX_REPS && timed(() => repeat(small, reps * GROWTH)) < MIN_BATCH_MS) reps *= 2;
  return reps;
}

function repeat(run: () => void, times: number): void {
  for (let i = 0; i < times; i += 1) run();
}
