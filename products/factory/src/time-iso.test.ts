import { describe, expect, it } from "vitest";
import { isoAt, parseIsoMs } from "./time-iso.js";

describe("time-iso", () => {
  it("round-trips a millisecond timestamp through its ISO string", () => {
    expect(isoAt(1_700_000_000_123)).toBe("2023-11-14T22:13:20.123Z");
    expect(parseIsoMs("2023-11-14T22:13:20.123Z")).toBe(1_700_000_000_123);
  });

  it("returns NaN for a string that is not a date", () => {
    expect(parseIsoMs("")).toBeNaN();
  });
});
