import { describe, expect, it } from "vitest";
import { aucInterval, rocAuc } from "./auc.js";

describe("rocAuc", () => {
  it("AUC is 1 when every positive outranks every negative, 0.5 on identical groups, ties count half", () => {
    expect(rocAuc([0.9, 0.8, 0.7], [0.1, 0.2, 0.3])).toBe(1);
    expect(rocAuc([0.1, 0.4, 0.7], [0.1, 0.4, 0.7])).toBe(0.5);
    // pairs of [2] against [1, 2]: one win, one tie
    expect(rocAuc([2], [1, 2])).toBe(0.75);
  });

  it("rejects an empty group", () => {
    expect(() => rocAuc([], [1])).toThrow(RangeError);
  });
});

describe("aucInterval", () => {
  const pos = [0.9, 0.8, 0.85, 0.3, 0.7, 0.95, 0.4, 0.6];
  const neg = [0.2, 0.5, 0.1, 0.65, 0.35, 0.45, 0.15, 0.55];

  it("interval resamples by cluster: two clusters of identical texts give a wider interval than the same texts unclustered", () => {
    const clustered = [0.9, 0.9, 0.9, 0.9, 0.3, 0.3, 0.3, 0.3];
    const keys = ["a", "a", "a", "a", "b", "b", "b", "b"];
    const negs = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

    const unclustered = aucInterval(clustered, negs, { resamples: 2000, seed: 1 });
    const byCluster = aucInterval(clustered, negs, { resamples: 2000, seed: 1, clusters: { pos: keys, neg: negs.map(() => "n") } });

    expect(byCluster.upper - byCluster.lower).toBeGreaterThan(unclustered.upper - unclustered.lower);
  });

  it("the same seed gives the same interval", () => {
    const first = aucInterval(pos, neg, { resamples: 500, seed: "s" });

    expect(aucInterval(pos, neg, { resamples: 500, seed: "s" })).toEqual(first);
    expect(first.estimate).toBe(rocAuc(pos, neg));
    expect(first.lower).toBeLessThanOrEqual(first.estimate);
    expect(first.upper).toBeGreaterThanOrEqual(first.estimate);
  });

  it("rejects cluster keys that differ in length from the scores", () => {
    expect(() => aucInterval([1, 2], [0], { clusters: { pos: ["a"], neg: ["n"] } })).toThrow(RangeError);
  });
});
