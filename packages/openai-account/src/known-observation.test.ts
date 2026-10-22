import { describe, expect, it } from "vitest";
import { knownObservation, quotaAdmission, type UsageResult } from "./index.js";

const now = 1_800_000_000;
const supplied = () => ({ account: "fixture", rate_limits: {
  five_hour: { used_percentage: 20, resets_at: now + 1000 },
  seven_day: { used_percentage: 70, resets_at: now + 2000 },
} });
const observed = () => knownObservation({ source: "synthetic-independent-observation", observedAt: now, reading: supplied() });

describe("explicit known observation factory", () => {
  it("requires a named time source rather than implicitly adopting an event timestamp", () => {
    // @ts-expect-error time provenance must be explicit, even when the timestamp is well formed
    expect(knownObservation({ observedAt: now, reading: supplied() })).toEqual({ status: "unknown", reason: "inconsistent" });
    // @ts-expect-error observation time cannot silently default to the local read clock
    expect(knownObservation({ source: "synthetic-independent-observation", reading: supplied() }))
      .toEqual({ status: "unknown", reason: "inconsistent" });
    for (const source of ["", "   "]) {
      expect(knownObservation({ source, observedAt: now, reading: supplied() })).toEqual({ status: "unknown", reason: "inconsistent" });
    }
    expect(quotaAdmission(observed(), now + 12)).toEqual({ allowed: true, ageSeconds: 12 });
  });
  it("uses the explicit observation clock rather than an extra written_at in supplied data", () => {
    const input = { ...supplied(), written_at: now + 500 };
    const result = knownObservation({ source: "synthetic-independent-observation", observedAt: now, reading: input });
    expect(quotaAdmission(result, now + 15)).toEqual({ allowed: true, ageSeconds: 15 });
  });
  it("keeps the existing serialized reading shape without exporting reusable provenance", () => {
    const result = observed();
    expect(result).toEqual({ status: "known", reading: { ...supplied(), written_at: now } });
    const decoded: unknown = JSON.parse(JSON.stringify(result));
    // @ts-expect-error decoded transport data has not explicitly established observation provenance
    expect(quotaAdmission(decoded, now)).toEqual({ allowed: false, reason: "inconsistent" });
    expect(JSON.stringify(result)).not.toContain("synthetic-independent-observation");
  });
  it("does not let a shallow copy silently inherit known provenance", () => {
    const result = observed();
    if (result.status !== "known") throw new Error("fixture not known");
    const copy: UsageResult = { status: "known", reading: { ...result.reading } };
    expect(quotaAdmission(copy, now)).toEqual({ allowed: false, reason: "inconsistent" });
  });
  it("binds written_at to the attested time rather than allowing a later refresh by mutation", () => {
    const result = observed();
    if (result.status !== "known") throw new Error("fixture not known");
    expect(Reflect.set(result.reading, "written_at", now + 10)).toBe(false);
    expect(result.reading.written_at).toBe(now);
    expect(quotaAdmission(result, now + 901)).toEqual({ allowed: false, reason: "stale", ageSeconds: 901 });
  });
  it("refuses an unknown status even when its reading has valid provenance", () => {
    const result = observed();
    if (result.status !== "known") throw new Error("fixture not known");
    // @ts-expect-error an unsupported runtime discriminant must refuse
    expect(quotaAdmission({ status: "future-status", reading: result.reading }, now))
      .toEqual({ allowed: false, reason: "inconsistent" });
  });
  it("copies the supplied counters instead of retaining a mutable input alias", () => {
    const input = supplied();
    const result = knownObservation({ source: "synthetic-independent-observation", observedAt: now, reading: input });
    input.rate_limits.five_hour.used_percentage = 100;
    expect(quotaAdmission(result, now)).toEqual({ allowed: true, ageSeconds: 0 });
  });
  it.each([NaN, Infinity, -1, now * 1000])("refuses an invalid observation clock %s", observedAt => {
    expect(knownObservation({ source: "synthetic-independent-observation", observedAt, reading: supplied() }))
      .toEqual({ status: "unknown", reason: "inconsistent" });
  });
  it("validates supplied shape and percentages instead of blessing any factory input", () => {
    const input = supplied(); input.rate_limits.five_hour.used_percentage = NaN;
    expect(knownObservation({ source: "synthetic-independent-observation", observedAt: now, reading: input }))
      .toEqual({ status: "unknown", reason: "inconsistent" });
    // @ts-expect-error malformed runtime input must not produce a known result
    expect(knownObservation({ source: "synthetic-independent-observation", observedAt: now, reading: {} }))
      .toEqual({ status: "unknown", reason: "inconsistent" });
  });
  it("reads the status discriminant once and preserves known unknown reasons", () => {
    let reads = 0;
    const result = { get status() { reads++; return "unknown" as const; }, reason: "missing" as const };
    expect(quotaAdmission(result, now)).toEqual({ allowed: false, reason: "missing" });
    expect(reads).toBe(1);
    let reasonReads = 0;
    const changing = { status: "unknown" as const, get reason() { reasonReads++; return reasonReads === 1 ? "missing" as const : "unreadable" as const; } };
    expect(quotaAdmission(changing, now)).toEqual({ allowed: false, reason: "missing" });
    expect(reasonReads).toBe(1);
    for (const reason of ["missing", "inconsistent", "unreadable", "freshness-unverified"] as const) {
      expect(quotaAdmission({ status: "unknown", reason }, now)).toEqual({ allowed: false, reason });
    }
  });
});
