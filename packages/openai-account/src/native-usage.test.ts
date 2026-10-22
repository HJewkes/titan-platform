import { describe, expect, it } from "vitest";
import { usageFromNativeResponse } from "./native-usage.js";
import { quotaAdmission } from "./usage.js";

const now = 1_800_000_000;
const binding = { account: "reporter", expectedAccountId: "workspace-test", startedAt: now };
function snapshot(week = 20) {
  return { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: now + 5000 },
    secondary: { usedPercent: week, windowDurationMins: 10080, resetsAt: now + 6000 } };
}
function response(week = 20) {
  return { accountId: "workspace-test", ordinaryUsageAllowed: true, rateLimits: snapshot(week),
    rateLimitsByLimitId: { codex: snapshot(week) } };
}

describe("native quota mapper", () => {
  it("maps only bound successful backend quota with request-start observation time", () => {
    const result = usageFromNativeResponse(response(), binding);
    expect(result).toEqual({ status: "known", reading: { account: "reporter", written_at: now,
      rate_limits: { five_hour: { used_percentage: 20, resets_at: now + 5000 },
        seven_day: { used_percentage: 20, resets_at: now + 6000 } } } });
    expect(quotaAdmission(result, now + 200)).toEqual({ allowed: true, ageSeconds: 200 });
    expect(JSON.stringify(result)).not.toContain("workspace-test");
  });
  it.each([null, false, undefined])("refuses unavailable backend identity readiness %s", allowed => {
    expect(usageFromNativeResponse({ ...response(), ordinaryUsageAllowed: allowed }, binding).status).toBe("unknown");
  });
  it.each([null, undefined, "other-workspace"]) ("refuses wrong or absent account %s", accountId => {
    expect(usageFromNativeResponse({ ...response(), accountId }, binding).status).toBe("unknown");
  });
  it("refuses missing expected binding and does not infer it from a label", () => {
    expect(usageFromNativeResponse(response(), { ...binding, expectedAccountId: "" }).status).toBe("unknown");
  });
  it("requires the codex map bucket without falling back to another bucket", () => {
    expect(usageFromNativeResponse({ ...response(), rateLimitsByLimitId: { other: snapshot() } }, binding).status).toBe("unknown");
    expect(usageFromNativeResponse({ ...response(), rateLimits: snapshot(30) }, binding).status).toBe("unknown");
    expect(usageFromNativeResponse({ ...response(), rateLimitsByLimitId: null }, binding).status).toBe("unknown");
  });
  it("accepts reversed window order, rejects duplicate or unknown window durations", () => {
    const data = response();
    const { primary, secondary } = data.rateLimits;
    data.rateLimits = { ...data.rateLimits, primary: secondary, secondary: primary };
    data.rateLimitsByLimitId.codex = data.rateLimits;
    expect(usageFromNativeResponse(data, binding).status).toBe("known");
    for (const duration of [300, 0, 18000]) {
      const invalid = response(); invalid.rateLimitsByLimitId.codex.secondary.windowDurationMins = duration;
      expect(usageFromNativeResponse(invalid, binding).status).toBe("unknown");
    }
  });
  it.each([NaN, Infinity, -1, 101, "20", null])("refuses invalid window percentage %s", usedPercent => {
    const data = response(); Object.assign(data.rateLimitsByLimitId.codex.primary, { usedPercent });
    expect(usageFromNativeResponse(data, binding).status).toBe("unknown");
  });
  it.each([now, now - 1, now * 1000, null, "1800001000"]) ("refuses invalid reset %s", resetsAt => {
    const data = response(); Object.assign(data.rateLimitsByLimitId.codex.primary, { resetsAt });
    expect(usageFromNativeResponse(data, binding).status).toBe("unknown");
  });
  it("keeps numerical Q5 boundaries meaningful", () => {
    expect(quotaAdmission(usageFromNativeResponse(response(86), binding), now + 900).allowed).toBe(true);
    expect(quotaAdmission(usageFromNativeResponse(response(86.001), binding), now).allowed).toBe(false);
    expect(quotaAdmission(usageFromNativeResponse(response(20), binding), now + 900.001)).toMatchObject({ reason: "stale" });
  });
  it("does not consume fabricated upstream observation timestamps or hostile getter errors", () => {
    expect(usageFromNativeResponse({ ...response(), fetchedAt: now + 900 }, binding)).toMatchObject({ reading: { written_at: now } });
    const hostile = Object.defineProperty({}, "accountId", { get() { throw new Error("secret"); } });
    expect(usageFromNativeResponse(hostile, binding)).toEqual({ status: "unknown", reason: "inconsistent" });
  });
});
