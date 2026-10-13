import { describe, expect, it } from "vitest";
import { averageLinkage } from "./average-linkage.js";

const indexes = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

describe("averageLinkage", () => {
  it("does not chain a line of neighbours into one cluster, as single link would", () => {
    const chain = (i: number, j: number): number => (Math.abs(i - j) === 1 ? 0.5 : 0);

    const clusters = averageLinkage(indexes(6), chain, { threshold: 0.4, maxSize: 25 });

    expect(clusters).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it("never grows a cluster past maxSize, even when every pair is similar", () => {
    const clusters = averageLinkage(indexes(10), () => 0.5, { threshold: 0.4, maxSize: 4 });

    expect(clusters).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
  });

  it("merges at exactly the threshold and not above it", () => {
    const similarity = (): number => 0.25;

    expect(averageLinkage(["a", "b"], similarity, { threshold: 0.25, maxSize: 25 })).toEqual([["a", "b"]]);
    expect(averageLinkage(["a", "b"], similarity, { threshold: 0.26, maxSize: 25 })).toEqual([["a"], ["b"]]);
  });

  it("breaks equal similarities toward the lowest pair in input order", () => {
    const clusters = averageLinkage(["a", "b", "c"], () => 0.5, { threshold: 0.4, maxSize: 2 });

    expect(clusters).toEqual([["a", "b"], ["c"]]);
  });
});
