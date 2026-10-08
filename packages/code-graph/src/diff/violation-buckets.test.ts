import { describe, expect, it } from "vitest";
import { bucketViolations, compareExcess, violationExcess, type BucketableViolation } from "./violation-buckets.js";

const v = (ruleId: string, nodeId: string, value?: number, threshold = 5): BucketableViolation => ({ ruleId, nodeId, value, threshold });

describe("bucketViolations without a store", () => {
  it("buckets new, resolved, worsened and improved violations by key", () => {
    const from = [v("loc", "a.ts", 10), v("loc", "b.ts", 10), v("loc", "gone.ts", 5), v("cycle", "c.ts")];
    const to = [v("loc", "a.ts", 12), v("loc", "b.ts", 8), v("cycle", "c.ts"), v("loc", "new.ts", 3)];

    const buckets = bucketViolations(from, to);

    expect(buckets.newViolations.map((x) => x.nodeId)).toEqual(["new.ts"]);
    expect(buckets.resolvedViolations.map((x) => x.nodeId)).toEqual(["gone.ts"]);
    expect(buckets.worsened.map((x) => [x.to.nodeId, x.delta])).toEqual([["a.ts", 2]]);
    expect(buckets.improved.map((x) => [x.to.nodeId, x.delta])).toEqual([["b.ts", -2]]);
    expect(buckets.unchanged.map((x) => x.to.nodeId)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("carries from-side ids through the resolver, so a moved file's violation is unchanged", () => {
    const moved = bucketViolations([v("loc", "old.ts", 4)], [v("loc", "new.ts", 4)], (id) => (id === "old.ts" ? "new.ts" : id));

    expect(moved.newViolations).toEqual([]);
    expect(moved.resolvedViolations).toEqual([]);
    expect(moved.unchanged).toHaveLength(1);
  });

  it("reads a falling value on a minimum rule as worsened", () => {
    const from = [v("cov", "a.ts", 60, 80), v("cov", "b.ts", 20, 80)];
    const to = [v("cov", "a.ts", 40, 80), v("cov", "b.ts", 50, 80)];

    const buckets = bucketViolations(from, to, undefined, () => "metric-min");

    expect(buckets.worsened.map((x) => [x.to.nodeId, x.delta])).toEqual([["a.ts", -20]]);
    expect(buckets.improved.map((x) => [x.to.nodeId, x.delta])).toEqual([["b.ts", 30]]);
  });

  it("calls a held value worsened when its threshold falls under it", () => {
    const buckets = bucketViolations([v("outlier", "a.ts", 10, 8)], [v("outlier", "a.ts", 10, 4)]);

    expect(buckets.worsened.map((x) => [x.to.nodeId, x.delta])).toEqual([["a.ts", 0]]);
  });

  it("leaves a pair with no excess on either side in unchanged only", () => {
    const from = [v("loc", "zero.ts", 1, 0), v("cov", "none.ts", 0, 80)];
    const to = [v("loc", "zero.ts", 3, 0), v("cov", "none.ts", 10, 80)];

    const buckets = bucketViolations(from, to, undefined, (id) => (id === "cov" ? "metric-min" : "metric-max"));

    expect(buckets.unchanged).toHaveLength(2);
    expect(buckets.worsened).toEqual([]);
    expect(buckets.improved).toEqual([]);
  });
});

describe("violationExcess", () => {
  it("is value over threshold for a maximum and threshold over value for a minimum", () => {
    expect(violationExcess("metric-max", 150, 100)).toBe(1.5);
    expect(violationExcess(undefined, 150, 100)).toBe(1.5);
    expect(violationExcess("metric-min", 40, 80)).toBe(2);
  });

  it("is null when the value or threshold is missing or the ratio has no meaning", () => {
    expect(violationExcess("metric-max", undefined, 100)).toBeNull();
    expect(violationExcess("metric-max", 5, undefined)).toBeNull();
    expect(violationExcess("metric-max", 5, 0)).toBeNull();
    expect(violationExcess("metric-min", 0, 80)).toBeNull();
  });
});

describe("compareExcess", () => {
  it("names the direction a violation moved relative to its threshold", () => {
    expect(compareExcess(1.2, 1.5)).toBe("worsened");
    expect(compareExcess(1.5, 1.2)).toBe("improved");
    expect(compareExcess(1.5, 1.5)).toBe("unchanged");
  });

  it("is null when either side has no excess", () => {
    expect(compareExcess(null, 1.5)).toBeNull();
    expect(compareExcess(1.5, null)).toBeNull();
  });
});
