import { randomInt, seededRandom } from "../seeded.js";
import type { Interval } from "./intervals.js";
import { assertCount, assertProbability } from "./validate.js";

export interface BootstrapOptions {
  confidence?: number;
  /** Number of resamples; defaults to 10000. */
  resamples?: number;
  /** Seed for `seededRandom`; defaults to 0, so an unseeded call is still reproducible. */
  seed?: string | number;
  /** The statistic computed on each resample; defaults to the mean. */
  statistic?: (sample: readonly number[]) => number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Linear interpolation between order statistics, numpy's default percentile rule.
function percentile(sorted: readonly number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const low = sorted[below] as number;
  const high = sorted[Math.min(below + 1, sorted.length - 1)] as number;
  return low === high ? low : low + (high - low) * (position - below);
}

/**
 * A percentile bootstrap interval for a statistic of one sample.
 * Pass one value per case (for example a case's pass rate over its trials), so resampling is by case.
 */
export function bootstrapCI(values: readonly number[], options: BootstrapOptions = {}): Interval {
  const { confidence = 0.95, resamples = 10000, seed = 0, statistic = mean } = options;
  assertCount("values.length", values.length, 1);
  assertCount("resamples", resamples, 1);
  assertProbability("confidence", confidence);
  const random = seededRandom(seed);
  const sample = new Array<number>(values.length);
  const stats = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < values.length; i++) sample[i] = values[randomInt(random, values.length)] as number;
    stats[r] = statistic(sample);
  }
  stats.sort((x, y) => x - y);
  const tail = (1 - confidence) / 2;
  return { estimate: statistic(values), lower: percentile(stats, tail), upper: percentile(stats, 1 - tail) };
}

/** A percentile bootstrap interval for mean(a[i] - b[i]), resampling cases so each pair stays together. */
export function pairedBootstrap(
  a: readonly number[],
  b: readonly number[],
  options: Omit<BootstrapOptions, "statistic"> = {},
): Interval {
  if (a.length !== b.length) throw new RangeError(`paired arms differ in length: ${a.length} and ${b.length}`);
  return bootstrapCI(
    a.map((value, i) => value - (b[i] as number)),
    options,
  );
}
