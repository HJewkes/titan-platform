import { describe, expect, it } from "vitest";
import { LimitsConfigError, PACE_DEFAULTS, checkLimits, parseLimits, resolveLimits, resolvePace } from "./index.js";
import today from "./fixtures/limits-today.json" with { type: "json" };
import withPace from "./fixtures/limits-pace.json" with { type: "json" };

const NOW = new Date("2026-10-09T12:00:00Z");

function paceFindings(raw: unknown) {
  return checkLimits(parseLimits(raw), { now: NOW }).filter((f) => f.kind === "invalid_pace");
}

describe("pace block", () => {
  it("leaves an old file without pace parsing as before and resolves to not present", () => {
    const parsed = parseLimits(today);

    expect(Object.keys(parsed.limits.pools)).toEqual(Object.keys(today.pools));
    expect(resolvePace(parsed)).toEqual({ present: false });
    expect(paceFindings(today)).toEqual([]);
  });

  it("fill finish hours from the default when the file sets mode and buffer only", () => {
    expect(resolvePace(parseLimits(withPace))).toEqual({
      present: true,
      mode: "shadow",
      buffer_points: 3,
      finish_hours_before_reset: 24,
    });
    expect(PACE_DEFAULTS).toEqual({ mode: "shadow", buffer_points: 3, finish_hours_before_reset: 24 });
  });

  it("keep the values the file sets over the defaults", () => {
    const raw = { ...today, pace: { mode: "on", buffer_points: 0, finish_hours_before_reset: 168 } };

    expect(resolvePace(parseLimits(raw))).toEqual({
      present: true,
      mode: "on",
      buffer_points: 0,
      finish_hours_before_reset: 168,
    });
  });

  it("drop an unknown mode with one finding and keep every pool open", () => {
    const raw = { ...today, pace: { mode: "bogus" } };
    const parse = () => parseLimits(raw);

    expect(parse).not.toThrow();
    for (const pool of Object.keys(today.pools)) {
      expect(resolveLimits(parse(), { pool, now: NOW }).open).toBe(true);
    }
    expect(resolvePace(parse())).toEqual({ present: false });
    expect(paceFindings(raw)).toHaveLength(1);
  });

  it.each([
    ["a negative buffer", { mode: "on", buffer_points: -1 }],
    ["finish hours above a week", { mode: "on", finish_hours_before_reset: 200 }],
    ["finish hours below zero", { mode: "on", finish_hours_before_reset: -1 }],
  ])("drop pace with %s", (_name, pace) => {
    const raw = { ...today, pace };

    expect(resolvePace(parseLimits(raw))).toEqual({ present: false });
    expect(paceFindings(raw)).toHaveLength(1);
  });

  it("drop pace with an unknown key", () => {
    const raw = { ...today, pace: { mode: "on", extra: 1 } };

    expect(resolvePace(parseLimits(raw))).toEqual({ present: false });
    expect(paceFindings(raw)).toHaveLength(1);
  });

  it("still refuse version 2 with a named error, pace or not", () => {
    expect(() => parseLimits({ ...withPace, version: 2 })).toThrow(LimitsConfigError);
    expect(() => parseLimits({ ...withPace, version: 2 })).toThrow(/limits block refused/);
  });
});
