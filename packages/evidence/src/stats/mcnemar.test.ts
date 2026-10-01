import { describe, expect, it } from "vitest";
import { mcnemar } from "./mcnemar.js";

// Reference: statsmodels 0.15.0 contingency_tables.mcnemar([[0, onlyA], [onlyB, 0]], exact=True).
const exactCases = [
  { onlyA: 1, onlyB: 9, statistic: 1, pValue: 0.021484 },
  { onlyA: 2, onlyB: 10, statistic: 2, pValue: 0.038574 },
  { onlyA: 5, onlyB: 19, statistic: 5, pValue: 0.006611 },
  { onlyA: 0, onlyB: 1, statistic: 0, pValue: 1 },
  { onlyA: 3, onlyB: 3, statistic: 3, pValue: 1 },
  { onlyA: 12, onlyB: 12, statistic: 12, pValue: 1 },
  { onlyA: 30, onlyB: 10, statistic: 10, pValue: 0.002221 },
];

// Reference: statsmodels 0.15.0 contingency_tables.mcnemar(..., exact=False, correction=True).
const chiSquareCases = [
  { onlyA: 30, onlyB: 10, statistic: 9.025, pValue: 0.002663 },
  { onlyA: 15, onlyB: 35, statistic: 7.22, pValue: 0.00721 },
  { onlyA: 1, onlyB: 9, statistic: 4.9, pValue: 0.026857 },
  { onlyA: 2, onlyB: 10, statistic: 4.083333, pValue: 0.043308 },
];

describe("mcnemar", () => {
  it.each(exactCases)("matches the exact binomial test for $onlyA and $onlyB", ({ onlyA, onlyB, statistic, pValue }) => {
    const result = mcnemar(onlyA, onlyB, { method: "exact" });

    expect(result.method).toBe("exact");
    expect(result.statistic).toBe(statistic);
    expect(result.pValue).toBeCloseTo(pValue, 3);
  });

  it.each(chiSquareCases)("matches the continuity-corrected chi-square for $onlyA and $onlyB", ({ onlyA, onlyB, statistic, pValue }) => {
    const result = mcnemar(onlyA, onlyB, { method: "chi-square" });

    expect(result.method).toBe("chi-square");
    expect(result.statistic).toBeCloseTo(statistic, 3);
    expect(result.pValue).toBeCloseTo(pValue, 3);
  });

  it("uses the exact test below 25 discordant pairs and chi-square from 25", () => {
    expect(mcnemar(5, 19).method).toBe("exact");
    expect(mcnemar(5, 20).method).toBe("chi-square");
  });

  it("gives p = 1 when there are no discordant pairs", () => {
    expect(mcnemar(0, 0)).toEqual({ method: "exact", statistic: 0, pValue: 1 });
    expect(mcnemar(0, 0, { method: "chi-square" })).toEqual({ method: "chi-square", statistic: 0, pValue: 1 });
  });

  it("floors the continuity correction at zero, so a chi-square tie gives p = 1", () => {
    expect(mcnemar(20, 20, { method: "chi-square" })).toEqual({ method: "chi-square", statistic: 0, pValue: 1 });
  });

  it("rejects counts that are not non-negative integers", () => {
    expect(() => mcnemar(-1, 3)).toThrow(RangeError);
    expect(() => mcnemar(1.5, 3)).toThrow(RangeError);
  });
});
