import { describe, expect, it } from "vitest";
import { GROWTH_RULE, growthOf, runVerdicts, shiftAt, type Point } from "./trend.js";

const series = (values: number[]): Point[] => values.map((ms, index) => ({ runId: `run-${index}`, commit: null, startedMs: index * 1000, ms }));

describe("growthOf", () => {
  it("flags a series whose last three runs all sit 30% over the trailing minimum", () => {
    const growth = growthOf(series([2000, 2100, 2050, 2000, 2600, 2700, 2650]));

    expect(growth).toMatchObject({ baselineMs: 2000, currentMs: 2600, deltaMs: 600, since: { runId: "run-4" } });
    expect(growth?.ratio).toBeCloseTo(0.3);
  });

  it("ignores one slow run among the last three, because the current level is their minimum", () => {
    // Mutant caught: taking the recent maximum instead of the minimum, which turns any spike into growth.
    expect(growthOf(series([2000, 2100, 2050, 2000, 4000, 2050, 2000]))).toBeNull();
  });

  it("ignores a rise under the absolute floor however large its ratio", () => {
    expect(growthOf(series([100, 100, 100, 300, 300, 300]))).toBeNull();
  });

  it("needs three baseline runs before it judges anything", () => {
    expect(growthOf(series([1000, 1000, 5000, 5000, 5000]))).toBeNull();
    expect(growthOf(series([1000, 1000, 1000, 5000, 5000, 5000]), GROWTH_RULE)).not.toBeNull();
  });
});

describe("runVerdicts", () => {
  it("marks a run once it and the run before it both sit 12% or more over the earlier minimum", () => {
    const verdicts = runVerdicts(series([1000, 1040, 1020, 1130, 1150]));

    expect(verdicts.map((verdict) => verdict.anomalous)).toEqual([false, false, false, false, true]);
    expect(verdicts[4]).toMatchObject({ rollingMinMs: 1000, heldRatio: expect.closeTo(0.13) });
  });

  it("lets one slow run pass", () => {
    // Mutant caught: a hold of one run, which alarms on every slow hosted runner.
    const verdicts = runVerdicts(series([1000, 1040, 1020, 1000, 1300, 1010, 1300]));

    expect(verdicts.some((verdict) => verdict.anomalous)).toBe(false);
    expect(verdicts[4]?.ratio).toBeCloseTo(0.3);
  });

  it("forgets runs older than the window", () => {
    const verdicts = runVerdicts(series([500, 1000, 1000, 1000, 1150, 1150]), { window: 3, minWindow: 3, threshold: 0.12, hold: 2 });

    expect(verdicts.at(-1)).toMatchObject({ rollingMinMs: 1000, anomalous: true });
  });
});

describe("shiftAt", () => {
  it("compares the minimum after a cut with the minimum of the window before it", () => {
    expect(shiftAt(series([1000, 900, 1000, 1200, 1300]), 3000, 2)).toEqual({ beforeMs: 900, afterMs: 1200, deltaMs: 300, ratio: expect.closeTo(1 / 3), afterRuns: 2 });
    expect(shiftAt(series([1000, 1100]), 5000, 10)).toBeNull();
  });
});
