import { describe, expect, it } from "vitest";
import { betaBinomialInterval, wilson } from "./intervals.js";

// Reference: statsmodels 0.15.0 proportion_confint(successes, n, alpha, method="wilson").
const wilsonCases = [
  { successes: 7, n: 10, confidence: 0.95, lower: 0.396778, upper: 0.892209 },
  { successes: 0, n: 10, confidence: 0.95, lower: 0, upper: 0.277533 },
  { successes: 10, n: 10, confidence: 0.95, lower: 0.722467, upper: 1 },
  { successes: 0, n: 1, confidence: 0.95, lower: 0, upper: 0.793451 },
  { successes: 1, n: 1, confidence: 0.95, lower: 0.206549, upper: 1 },
  { successes: 15, n: 30, confidence: 0.95, lower: 0.331541, upper: 0.668459 },
  { successes: 29, n: 30, confidence: 0.9, lower: 0.863596, upper: 0.992528 },
  { successes: 3, n: 50, confidence: 0.99, lower: 0.015295, upper: 0.207799 },
];

// Reference: scipy 1.18.1 stats.beta(successes + alpha, n - successes + beta).ppf at (1 - confidence) / 2 and its complement.
const jeffreys = { alpha: 0.5, beta: 0.5 };
const uniform = { alpha: 1, beta: 1 };
const betaCases = [
  { successes: 7, n: 10, confidence: 0.95, prior: jeffreys, lower: 0.394182, upper: 0.907305 },
  { successes: 0, n: 10, confidence: 0.95, prior: jeffreys, lower: 0.000048, upper: 0.217196 },
  { successes: 10, n: 10, confidence: 0.95, prior: jeffreys, lower: 0.782804, upper: 0.999952 },
  { successes: 0, n: 1, confidence: 0.95, prior: jeffreys, lower: 0.000386, upper: 0.853254 },
  { successes: 1, n: 1, confidence: 0.95, prior: jeffreys, lower: 0.146746, upper: 0.999614 },
  { successes: 15, n: 30, confidence: 0.95, prior: jeffreys, lower: 0.328021, upper: 0.671979 },
  { successes: 3, n: 50, confidence: 0.99, prior: jeffreys, lower: 0.010097, upper: 0.187883 },
  { successes: 7, n: 10, confidence: 0.95, prior: uniform, lower: 0.390257, upper: 0.890737 },
  { successes: 0, n: 10, confidence: 0.95, prior: uniform, lower: 0.002299, upper: 0.284914 },
  { successes: 29, n: 30, confidence: 0.9, prior: uniform, lower: 0.85591, upper: 0.988415 },
];

describe("wilson", () => {
  it.each(wilsonCases)("matches statsmodels for $successes of $n at $confidence", ({ successes, n, confidence, lower, upper }) => {
    const interval = wilson(successes, n, { confidence });

    expect(interval.estimate).toBeCloseTo(successes / n, 12);
    expect(interval.lower).toBeCloseTo(lower, 3);
    expect(interval.upper).toBeCloseTo(upper, 3);
  });

  it("defaults to 95 percent", () => {
    expect(wilson(7, 10)).toEqual(wilson(7, 10, { confidence: 0.95 }));
  });

  it("rejects counts that are not a rate", () => {
    expect(() => wilson(0, 0)).toThrow(RangeError);
    expect(() => wilson(11, 10)).toThrow(RangeError);
    expect(() => wilson(1.5, 10)).toThrow(RangeError);
    expect(() => wilson(1, 10, { confidence: 1 })).toThrow(RangeError);
  });
});

describe("betaBinomialInterval", () => {
  it.each(betaCases)(
    "matches scipy for $successes of $n at $confidence with prior $prior.alpha",
    ({ successes, n, confidence, prior, lower, upper }) => {
      const interval = betaBinomialInterval(successes, n, { confidence, prior });

      expect(interval.estimate).toBeCloseTo(successes / n, 12);
      expect(interval.lower).toBeCloseTo(lower, 3);
      expect(interval.upper).toBeCloseTo(upper, 3);
    },
  );

  it("defaults to the Jeffreys prior at 95 percent", () => {
    expect(betaBinomialInterval(7, 10)).toEqual(betaBinomialInterval(7, 10, { confidence: 0.95, prior: jeffreys }));
  });

  it("rejects a non-positive prior", () => {
    expect(() => betaBinomialInterval(1, 10, { prior: { alpha: 0, beta: 1 } })).toThrow(RangeError);
  });
});
