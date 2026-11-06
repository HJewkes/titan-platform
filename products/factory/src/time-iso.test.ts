import { afterEach, describe, expect, it, vi } from "vitest";
import { isoAt, parseIsoMs, wallClock } from "./time-iso.js";

describe("time-iso", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips a millisecond timestamp through its ISO string", () => {
    expect(isoAt(1_700_000_000_123)).toBe("2023-11-14T22:13:20.123Z");
    expect(parseIsoMs("2023-11-14T22:13:20.123Z")).toBe(1_700_000_000_123);
  });

  it("returns NaN for a string that is not a date", () => {
    expect(parseIsoMs("")).toBeNaN();
  });

  it("reads the faked clock at call time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    expect(wallClock()).toBe(5_000);
    vi.setSystemTime(9_000);
    expect(wallClock()).toBe(9_000);
  });
});
