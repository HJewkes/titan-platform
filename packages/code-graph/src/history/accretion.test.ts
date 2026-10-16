import { describe, expect, it } from "vitest";
import { carryLine } from "./accretion.js";

describe("carryLine", () => {
  const hunks = [
    { oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 },
    { oldStart: 5, oldCount: 2, newStart: 8, newCount: 1 },
  ];

  it("shifts a line below an insertion and a shrinking rewrite", () => {
    expect(carryLine(9, hunks)).toBe(11);
  });

  it("maps a rewritten line to the start of its replacement", () => {
    expect(carryLine(6, hunks)).toBe(8);
  });

  it("shifts a line between the hunks by the insertion only", () => {
    expect(carryLine(4, hunks)).toBe(7);
  });
});
