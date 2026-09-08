import { describe, expect, it } from "vitest";
import { formatLocator, isLocator, parseLocator } from "./locator.js";

describe("locator guard and formatting", () => {
  it("accepts a non-negative triple with positive length", () => {
    expect(isLocator([0, 0, 1])).toBe(true);
    expect(isLocator([3, 1024, 88])).toBe(true);
  });

  it("rejects wrong arity, negatives, floats, and zero length", () => {
    expect(isLocator([0, 0])).toBe(false);
    expect(isLocator([0, -1, 5])).toBe(false);
    expect(isLocator([0, 1.5, 5])).toBe(false);
    expect(isLocator([0, 0, 0])).toBe(false);
    expect(isLocator("0:0:1")).toBe(false);
  });

  it("round-trips the compact string form", () => {
    expect(formatLocator([3, 1024, 88])).toBe("3:1024:88");
    expect(parseLocator("3:1024:88")).toEqual([3, 1024, 88]);
  });

  it("throws on a malformed string", () => {
    expect(() => parseLocator("3:1024")).toThrow(/invalid locator/);
    expect(() => parseLocator("a:b:c")).toThrow(/invalid locator/);
    expect(() => parseLocator("1::2")).toThrow(/invalid locator/);
  });
});
