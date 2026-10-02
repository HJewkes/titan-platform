import { normalQuantile } from "./distributions.js";
import { assertCount, assertProbability } from "./validate.js";

export interface DetectableEffectOptions {
  /** Number of paired cases. */
  n: number;
  /** Standard deviation of the per-case difference; 0.5 is the largest a single pass/fail rate can have, but a paired binary difference can reach 1. */
  sd: number;
  /** Significance level; defaults to 0.05. */
  alpha?: number;
  /** Probability of detecting the effect; defaults to 0.8. */
  power?: number;
  /** 2 (default) for a two-sided test, 1 for one-sided. */
  sides?: 1 | 2;
}

/**
 * The smallest mean paired difference a z-test on n cases detects at the given alpha and power:
 * sd * (z(1 - alpha / sides) + z(power)) / sqrt(n). Defaults: two-sided, alpha 0.05, power 0.8.
 * A planning figure under the normal approximation, so it is optimistic below about 30 cases.
 */
export function minimumDetectableEffect(options: DetectableEffectOptions): number {
  const { n, sd, alpha = 0.05, power = 0.8, sides = 2 } = options;
  assertCount("n", n, 1);
  assertProbability("alpha", alpha);
  assertProbability("power", power);
  if (!(sd >= 0)) throw new RangeError(`sd must be non-negative, got ${sd}`);
  return (sd * (normalQuantile(1 - alpha / sides) + normalQuantile(power))) / Math.sqrt(n);
}
