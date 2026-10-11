import { wilson } from "@titan-design/evidence/stats";
import { describe, expect, it } from "vitest";
import {
  averageRanks,
  conformalFactor,
  contextLineScore,
  intervalCoverage,
  meanPinballLoss,
  medianAbsLogError,
  pinballLoss,
  predictsOverContextLine,
  spearman,
  widen,
  wideningFactor,
} from "./backtest-metrics.js";

const interval = (actual: number, p10 = 2, p50 = 4, p90 = 6) => ({ actual, p10, p50, p90 });

describe("intervalCoverage", () => {
  it("counts actuals inside [p10, p90], boundaries included, with a Wilson interval", () => {
    const coverage = intervalCoverage([interval(3), interval(1), interval(6), interval(9)]);

    expect(coverage.hits).toBe(2);
    expect(coverage.n).toBe(4);
    expect(coverage.rate).toEqual(wilson(2, 4));
  });

  it("reports no rate for an empty set rather than throwing", () => {
    expect(intervalCoverage([])).toEqual({ hits: 0, n: 0, rate: null });
  });
});

describe("pinball loss", () => {
  it("charges tau per unit under-prediction and 1 - tau per unit over-prediction", () => {
    expect(pinballLoss(10, 8, 0.9)).toBeCloseTo(1.8);
    expect(pinballLoss(8, 10, 0.9)).toBeCloseTo(0.2);
    expect(pinballLoss(8, 10, 0.5)).toBeCloseTo(1);
  });

  it("averages over rows and is null when empty", () => {
    const rows = [
      { actual: 10, predicted: 8 },
      { actual: 8, predicted: 10 },
    ];
    expect(meanPinballLoss(rows, 0.1)).toBeCloseTo(1);
    expect(meanPinballLoss([], 0.1)).toBeNull();
  });
});

describe("medianAbsLogError", () => {
  it("stays finite at zero hours through the one-minute floor", () => {
    const rows = [
      { actual: 0, predicted: 0 },
      { actual: 0, predicted: 1 },
      { actual: 1, predicted: 0 },
    ];
    expect(medianAbsLogError(rows)).toBeCloseTo(Math.log(61));
  });

  it("averages the middle pair for an even count and is null when empty", () => {
    const rows = [
      { actual: 1, predicted: 1 },
      { actual: 0, predicted: 1 },
    ];
    expect(medianAbsLogError(rows)).toBeCloseTo(Math.log(61) / 2);
    expect(medianAbsLogError([])).toBeNull();
  });
});

describe("spearman", () => {
  it("gives tied values the average of the ranks they span", () => {
    expect(averageRanks([20, 10, 30, 20])).toEqual([2.5, 1, 4, 2.5]);
  });

  it("is 1 for a monotone relation and -1 for a reversed one", () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [16, 9, 4, 1])).toBeCloseTo(-1);
  });

  it("uses average ranks under ties", () => {
    expect(spearman([1, 2, 2, 3], [1, 2, 3, 4])).toBeCloseTo(4.5 / Math.sqrt(22.5));
  });

  it("is null under three pairs or when one side is constant", () => {
    expect(spearman([1, 2], [2, 1])).toBeNull();
    expect(spearman([2, 2, 2], [1, 2, 3])).toBeNull();
  });

  it("rejects unequal lengths", () => {
    expect(() => spearman([1, 2, 3], [1, 2])).toThrow(RangeError);
  });
});

describe("150k context line", () => {
  it("predicts over only when strictly more than half of the training peaks exceed 150,000", () => {
    expect(predictsOverContextLine([200_000, 100_000])).toBe(false);
    expect(predictsOverContextLine([200_000, 200_000, 150_000])).toBe(true);
    expect(predictsOverContextLine([150_000, 150_000, 200_000])).toBe(false);
    expect(predictsOverContextLine([])).toBe(false);
  });

  it("scores precision and recall over rows carrying a peak", () => {
    const score = contextLineScore([
      { predictedOver: true, peakContextTokens: 180_000 },
      { predictedOver: true, peakContextTokens: 90_000 },
      { predictedOver: false, peakContextTokens: 160_000 },
      { predictedOver: false, peakContextTokens: 40_000 },
    ]);

    expect(score).toEqual({ n: 4, truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5 });
  });

  it("is null with no rows and leaves precision null when nothing was predicted over", () => {
    expect(contextLineScore([])).toBeNull();
    expect(contextLineScore([{ predictedOver: false, peakContextTokens: 200_000 }])?.precision).toBeNull();
  });
});

describe("conformal widening", () => {
  it("is 1 inside the interval and just enough to reach the actual outside it", () => {
    expect(wideningFactor(interval(5))).toBe(1);
    expect(wideningFactor(interval(10))).toBeCloseTo(3);
    expect(wideningFactor(interval(0))).toBeCloseTo(2);
  });

  it("floors a zero-width side at one minute so the factor stays finite", () => {
    const row = interval(2, 1, 1, 1);
    const k = wideningFactor(row);

    expect(k).toBeCloseTo(60);
    expect(intervalCoverage([widen(row, k)]).hits).toBe(1);
  });

  it("takes the 0.8 weighted quantile of per-row factors, 1 when empty", () => {
    const rows = Array.from({ length: 10 }, (_, i) => interval(4 + 2 * (i + 1)));

    expect(conformalFactor(rows)).toBeCloseTo(8);
    expect(conformalFactor([{ ...interval(8), weight: 9 }, { ...interval(5), weight: 1 }])).toBeCloseTo(2);
    expect(conformalFactor([])).toBe(1);
  });

  it("widens [p10, p90] about p50 and leaves the interval alone at k = 1", () => {
    expect(widen(interval(0), 2)).toEqual({ actual: 0, p10: 0, p50: 4, p90: 8 });
    expect(widen(interval(0), 1)).toEqual(interval(0));
  });
});
