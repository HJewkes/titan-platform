import { describe, expect, it } from "vitest";
import { knownObservation, quotaAdmission } from "./index.js";

const now = 1_800_000_000;
const supplied = (five = 20) => ({ account: "fixture", rate_limits: {
  five_hour: { used_percentage: five, resets_at: now + 1000 },
  seven_day: { used_percentage: 70, resets_at: now + 2000 },
} });

describe("known observation identity and immutable snapshot", () => {
  it("refuses a plain reading carrying every reflected provenance symbol", () => {
    const result = knownObservation({ source: "synthetic-observation", observedAt: now, reading: supplied() });
    if (result.status !== "known") throw new Error("fixture not known");
    const forged = { ...result.reading };
    for (const key of Object.getOwnPropertySymbols(result.reading)) {
      const descriptor = Object.getOwnPropertyDescriptor(result.reading, key);
      if (descriptor) Object.defineProperty(forged, key, descriptor);
    }
    expect(quotaAdmission(result, now)).toEqual({ allowed: true, ageSeconds: 0 });
    expect(quotaAdmission({ status: "known", reading: forged }, now))
      .toEqual({ allowed: false, reason: "inconsistent" });
  });

  it("does not let returned five-hour counters mutate a ceiling refusal into admission", () => {
    const result = knownObservation({ source: "synthetic-observation", observedAt: now, reading: supplied(100) });
    if (result.status !== "known") throw new Error("fixture not known");
    expect(quotaAdmission(result, now)).toEqual({ allowed: false, reason: "five-hour-ceiling", ageSeconds: 0 });
    const changed = Reflect.set(result.reading.rate_limits.five_hour, "used_percentage", 0);
    expect(quotaAdmission(result, now)).toEqual({ allowed: false, reason: "five-hour-ceiling", ageSeconds: 0 });
    expect(result.reading.rate_limits.five_hour.used_percentage).toBe(100);
    expect(changed).toBe(false);
  });

  it("copies and freezes only its snapshot while leaving caller-owned counters mutable", () => {
    const input = supplied(100);
    const result = knownObservation({ source: "synthetic-observation", observedAt: now, reading: input });
    if (result.status !== "known") throw new Error("fixture not known");
    input.rate_limits.five_hour.used_percentage = 0;
    expect(input.rate_limits.five_hour.used_percentage).toBe(0);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.rate_limits)).toBe(false);
    expect(Object.isFrozen(input.rate_limits.five_hour)).toBe(false);
    expect(result.reading.rate_limits.five_hour.used_percentage).toBe(100);
    expect(quotaAdmission(result, now)).toEqual({ allowed: false, reason: "five-hour-ceiling", ageSeconds: 0 });
  });
  it("freezes the root and limits containers so replacing a full window cannot change admission", () => {
    for (const replaceRoot of [true, false]) {
      const result = knownObservation({ source: "synthetic-observation", observedAt: now, reading: supplied(100) });
      if (result.status !== "known") throw new Error("fixture not known");
      const changed = replaceRoot
        ? Reflect.set(result.reading, "rate_limits", supplied().rate_limits)
        : Reflect.set(result.reading.rate_limits, "five_hour", supplied().rate_limits.five_hour);
      expect(quotaAdmission(result, now)).toEqual({ allowed: false, reason: "five-hour-ceiling", ageSeconds: 0 });
      expect(changed).toBe(false);
    }
  });

  it("freezes the weekly counter and keeps all validated fields in the snapshot", () => {
    const input = supplied(); input.rate_limits.seven_day.used_percentage = 100;
    const result = knownObservation({ source: "synthetic-observation", observedAt: now, reading: input });
    if (result.status !== "known") throw new Error("fixture not known");
    const changed = Reflect.set(result.reading.rate_limits.seven_day, "used_percentage", 0);
    expect(quotaAdmission(result, now)).toEqual({ allowed: false, reason: "weekly-reserve", ageSeconds: 0 });
    expect(changed).toBe(false);
    expect(result.reading).toEqual({ ...input, written_at: now });
    for (const value of [result.reading, result.reading.rate_limits,
      result.reading.rate_limits.five_hour, result.reading.rate_limits.seven_day]) expect(Object.isFrozen(value)).toBe(true);
  });

  it("does not extend a reset by mutating an observation window", () => {
    const input = supplied(); input.rate_limits.five_hour.resets_at = now + 10;
    const result = knownObservation({ source: "synthetic-observation", observedAt: now, reading: input });
    if (result.status !== "known") throw new Error("fixture not known");
    const changed = Reflect.set(result.reading.rate_limits.five_hour, "resets_at", now + 1000);
    expect(quotaAdmission(result, now + 11)).toEqual({ allowed: false, reason: "inconsistent" });
    expect(changed).toBe(false);
  });

});
