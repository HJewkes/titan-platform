import { betaQuantile, normalQuantile } from "./distributions.js";
import { assertProbability, assertRate } from "./validate.js";

export interface Interval {
  estimate: number;
  lower: number;
  upper: number;
}

/** Shape parameters of a Beta prior on a pass rate. */
export interface BetaPrior {
  alpha: number;
  beta: number;
}

const JEFFREYS: BetaPrior = { alpha: 0.5, beta: 0.5 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The Wilson score interval for successes out of trials; estimate is the observed rate. */
export function wilson(successes: number, trials: number, options: { confidence?: number } = {}): Interval {
  const confidence = options.confidence ?? 0.95;
  assertRate(successes, trials);
  assertProbability("confidence", confidence);
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const rate = successes / trials;
  const z2n = (z * z) / trials;
  const centre = (rate + z2n / 2) / (1 + z2n);
  const half = (z / (1 + z2n)) * Math.sqrt((rate * (1 - rate)) / trials + z2n / (4 * trials));
  return { estimate: rate, lower: clamp01(centre - half), upper: clamp01(centre + half) };
}

/**
 * The equal-tailed credible interval of the Beta posterior for a pass rate.
 * The default Jeffreys prior Beta(0.5, 0.5) gives good frequentist coverage at small n.
 */
export function betaBinomialInterval(
  successes: number,
  trials: number,
  options: { confidence?: number; prior?: BetaPrior } = {},
): Interval {
  const confidence = options.confidence ?? 0.95;
  const prior = options.prior ?? JEFFREYS;
  assertRate(successes, trials);
  assertProbability("confidence", confidence);
  if (!(prior.alpha > 0 && prior.beta > 0)) throw new RangeError("prior alpha and beta must both be positive");
  const a = successes + prior.alpha;
  const b = trials - successes + prior.beta;
  const tail = (1 - confidence) / 2;
  return { estimate: successes / trials, lower: betaQuantile(tail, a, b), upper: betaQuantile(1 - tail, a, b) };
}
