import { describe, expect, it } from "vitest";
import { bootstrapCI, pairedBootstrap } from "./bootstrap.js";

// Reference: the exact bootstrap distribution of the mean, enumerated over all n^n resamples in Python.
// Its 2.5 and 97.5 percentiles sit on atoms at least 0.0055 of probability from the next atom,
// so a 20000-resample percentile interval lands on the same atoms for any seed.
const resamples = 20000;

describe("bootstrapCI", () => {
  it("matches the enumerated percentile interval of the mean", () => {
    const values = [0, 1 / 3, 1, 2 / 3, 1];

    const interval = bootstrapCI(values, { resamples, seed: "case-a" });

    expect(interval.estimate).toBeCloseTo(0.6, 12);
    expect(interval.lower).toBeCloseTo(0.266667, 3);
    expect(interval.upper).toBeCloseTo(0.933333, 3);
  });

  it("gives the same interval for the same seed and a different one for another seed", () => {
    const values = [0.2, 0.9, 0.4, 0.75, 0.1, 0.6, 0.35];

    const first = bootstrapCI(values, { seed: 7 });

    expect(bootstrapCI(values, { seed: 7 })).toEqual(first);
    expect(bootstrapCI(values, { seed: 8 })).not.toEqual(first);
  });

  it("is deterministic with no seed given", () => {
    expect(bootstrapCI([0.2, 0.9, 0.4])).toEqual(bootstrapCI([0.2, 0.9, 0.4]));
  });

  it("collapses to the value when every case agrees", () => {
    expect(bootstrapCI([1, 1, 1, 1], { resamples: 500 })).toEqual({ estimate: 1, lower: 1, upper: 1 });
  });

  it("applies a custom statistic to each resample", () => {
    const interval = bootstrapCI([3, 1, 2], { statistic: (sample) => Math.max(...sample), resamples: 500 });

    expect(interval.estimate).toBe(3);
    expect(interval.upper).toBe(3);
    expect(interval.lower).toBeGreaterThanOrEqual(1);
  });

  it("returns a single value as a zero-width interval", () => {
    expect(bootstrapCI([0.4])).toEqual({ estimate: 0.4, lower: 0.4, upper: 0.4 });
  });

  it("rejects an empty sample and a non-integer resample count", () => {
    expect(() => bootstrapCI([])).toThrow(RangeError);
    expect(() => bootstrapCI([1, 2], { resamples: 0 })).toThrow(RangeError);
  });
});

describe("pairedBootstrap", () => {
  it("matches the enumerated percentile interval of the mean paired difference", () => {
    const a = [1, 1, 0, 1, 1, 0];
    const b = [0, 1, 0, 0, 1, 1];

    const interval = pairedBootstrap(a, b, { resamples, seed: "case-b" });

    expect(interval.estimate).toBeCloseTo(1 / 6, 12);
    expect(interval.lower).toBeCloseTo(-0.333333, 3);
    expect(interval.upper).toBeCloseTo(0.666667, 3);
  });

  it("resamples cases together, so identical arms give a zero-width interval", () => {
    const arm = [0.1, 0.8, 0.5, 0.3];

    expect(pairedBootstrap(arm, arm)).toEqual({ estimate: 0, lower: 0, upper: 0 });
  });

  it("is reproducible for a seed", () => {
    const a = [0.5, 0.9, 0.2, 0.7];
    const b = [0.4, 0.6, 0.3, 0.2];

    expect(pairedBootstrap(a, b, { seed: "s" })).toEqual(pairedBootstrap(a, b, { seed: "s" }));
  });

  it("rejects arms of different lengths", () => {
    expect(() => pairedBootstrap([1, 0], [1])).toThrow(RangeError);
  });
});
