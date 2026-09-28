import { describe, expect, it } from "vitest";
import type { LineRange } from "./citation.js";
import { groupByOverlap, rangesOverlap } from "./overlap.js";

const r = (lineStart: number, lineEnd: number, path = "a.ts"): LineRange => ({ path, lineStart, lineEnd });
const ids = (groups: { id: string }[][]) => groups.map((g) => g.map((item) => item.id));

describe("rangesOverlap", () => {
  it("groups ranges that share their boundary line", () => {
    expect(rangesOverlap(r(10, 12), r(12, 14))).toBe(true);
  });

  it("keeps adjacent ranges that share no line apart", () => {
    expect(rangesOverlap(r(10, 12), r(13, 14))).toBe(false);
  });

  it("keeps the same lines in different files apart", () => {
    expect(rangesOverlap(r(10, 12), r(10, 12, "b.ts"))).toBe(false);
  });
});

describe("groupByOverlap", () => {
  const items = [
    { id: "a", ranges: [r(10, 12)] },
    { id: "b", ranges: [r(13, 14)] },
    { id: "c", ranges: [r(12, 13)] },
    { id: "d", ranges: [r(1, 2, "b.ts")] },
  ];

  it("joins groups transitively through a bridging item and keeps input order", () => {
    expect(ids(groupByOverlap(items, (i) => i.ranges))).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("requires the extra relation when one is given", () => {
    const related = (x: { id: string }, y: { id: string }) => x.id !== "a" && y.id !== "a";
    expect(ids(groupByOverlap(items, (i) => i.ranges, { related }))).toEqual([["a"], ["b", "c"], ["d"]]);
  });
});
