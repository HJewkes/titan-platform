import { describe, expect, it } from "vitest";
import { quotaAdmission, type UsageResult } from "./index.js";

const now = 1_800_000_000;
const reading = {
  account: "fixture", written_at: now,
  rate_limits: {
    five_hour: { used_percentage: 20, resets_at: now + 1000 },
    seven_day: { used_percentage: 70, resets_at: now + 2000 },
  },
};

describe("quota provenance and defensive admission", () => {
  it("does not launder a rollout emission timestamp into known admission", () => {
    const event = { timestamp: new Date(now * 1000).toISOString() };
    const candidate = { status: "known" as const, reading: { ...reading, written_at: Date.parse(event.timestamp) / 1000 } };
    // @ts-expect-error a known result requires explicit observation provenance
    const unverified: UsageResult = candidate;
    expect(quotaAdmission(unverified, now)).toEqual({ allowed: false, reason: "inconsistent" });
  });
  it.each<unknown>([
    null, undefined, {}, { status: "future-status", reading },
    { status: "known" }, { status: "known", reading: { written_at: now } },
    { status: "known", reading: { ...reading, rate_limits: null } },
    { status: "unknown", reason: "future-reason" },
    { get status() { throw new Error("synthetic private error"); } },
  ])("refuses malformed runtime input without throwing: %#", candidate => {
    // @ts-expect-error deliberate invalid runtime input exercises the defensive boundary
    expect(quotaAdmission(candidate, now)).toEqual({ allowed: false, reason: "inconsistent" });
  });
});
