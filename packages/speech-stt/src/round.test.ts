import { describe, expect, it } from "vitest";
import { roundHalfEven, roundMillis } from "./round.js";

describe("roundHalfEven", () => {
  // Mutation caught: Number(x.toFixed(digits)), which breaks exact ties upward to 0.063 and 0.13.
  it("breaks an exact binary tie to the even digit, as Python's round does", () => {
    expect(roundHalfEven(0.0625, 3)).toBe(0.062);
    expect(roundHalfEven(0.125, 2)).toBe(0.12);
    expect(roundHalfEven(0.375, 2)).toBe(0.38);
    expect(roundHalfEven(-0.0625, 3)).toBe(-0.062);
  });

  // Mutation caught: treating the decimal literal 2.675 as a tie; its binary value sits below it.
  it("rounds a value that only looks like a tie by its binary value", () => {
    expect(roundHalfEven(2.675, 2)).toBe(2.67);
    expect(roundHalfEven(1 / 3, 2)).toBe(0.33);
  });

  // Mutation caught: a tie test that slices from a fixed 3-digit offset, which misreads 0.5 and 1.5.
  it("rounds whole numbers half to even at zero digits", () => {
    expect(roundHalfEven(0.5, 0)).toBe(0);
    expect(roundHalfEven(1.5, 0)).toBe(2);
  });

  it("leaves roundMillis as round(x, 3)", () => {
    expect(roundMillis(0.0625)).toBe(0.062);
    expect(roundMillis(0.1875)).toBe(0.188);
  });
});
