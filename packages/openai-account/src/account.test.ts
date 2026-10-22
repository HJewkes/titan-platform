import { describe, expect, it } from "vitest";
import { accountLabel, loginStateFromStatus, quotaAdmission, knownObservation, redactSecrets, usageFromRolloutEvents, type UsageResult } from "./index.js";

import { validateRolloutWindows } from "./usage.js";

const now = 1_800_000_000;
function event(used = 70, at = now) {
  return { timestamp: new Date(at * 1000).toISOString(), type: "event_msg", payload: {
    type: "token_count", rate_limits: {
      primary: { used_percent: 20, window_minutes: 300, resets_at: now + 1000 },
      secondary: { used_percent: used, window_minutes: 10080, resets_at: now + 2000 },
      credits: { secret: "private" },
    },
  } };
}

// Supplied observations test policy independently of the untrusted rollout envelope.
function observed(used = 70, at = now, five = 20): UsageResult {
  return knownObservation({ source: "synthetic-independent-observation", observedAt: at, reading: { account: "reporter",
    rate_limits: { five_hour: { used_percentage: five, resets_at: now + 1000 },
      seven_day: { used_percentage: used, resets_at: now + 2000 } } } });
}

describe("read-only Codex account core", () => {
  it("refuses cached native quota re-emission without inventing observation freshness", () => {
    const stale = event(20, now - 1200);
    const cached = { ...stale, timestamp: new Date(now * 1000).toISOString() };
    const result = usageFromRolloutEvents([stale, cached], "fixture");
    expect(result).toEqual({ status: "unknown", reason: "freshness-unverified" });
    expect(quotaAdmission(result, now)).toEqual({ allowed: false, reason: "freshness-unverified" });
  });
  it("recognizes ChatGPT login on either CLI output stream without returning output", () => {
    expect(loginStateFromStatus({ exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT\n" }))
      .toEqual({ status: "present", method: "chatgpt" });
    expect(loginStateFromStatus({ exitCode: 1, stdout: "", stderr: "Not logged in" })).toEqual({ status: "missing" });
  });
  it.each([
    { exitCode: 0, stdout: "Logged in using an API key - sk-test-secret", stderr: "" },
    { exitCode: 0, stdout: "future format secret", stderr: "" },
    { exitCode: 2, stdout: "Logged in using ChatGPT", stderr: "" },
  ])("refuses unsupported or inconsistent login evidence", result => {
    const state = loginStateFromStatus(result);
    expect(state.status).toBe("refused");
    expect(JSON.stringify(state)).not.toMatch(/secret|sk-test/);
  });
  it("refuses valid native quota because envelope time is not a fetch timestamp", () => {
    for (const events of [[event()], [event(95, now), event(20, now - 60)], [event(20, now + 0.123)],
      [event(20, now - 1200)], [event(20), event(21, now + 1)]]) {
      expect(usageFromRolloutEvents(events, "reporter"))
        .toEqual({ status: "unknown", reason: "freshness-unverified" });
    }
  });
  it("preserves caller-established observation age for quota policy", () => {
    expect(quotaAdmission(observed(), now + 12)).toEqual({ allowed: true, ageSeconds: 12 });
    expect(quotaAdmission(observed(20, now + 0.123), now + 1))
      .toEqual({ allowed: true, ageSeconds: expect.closeTo(0.877) });
  });
  it.each([[86, true], [86.001, false], [100, false]])("weekly used %s admission=%s", (used, allowed) => {
    expect(quotaAdmission(observed(used), now).allowed).toBe(allowed);
  });
  it("refuses five-hour ceiling and stale evidence; exact age boundary is allowed", () => {
    const result = observed();
    expect(quotaAdmission(result, now + 900).allowed).toBe(true);
    expect(quotaAdmission(result, now + 901)).toMatchObject({ allowed: false, reason: "stale" });
    const full = observed(70, now, 100);
    expect(quotaAdmission(full, now)).toMatchObject({ allowed: false, reason: "five-hour-ceiling" });
  });
  it.each([null, {}, { primary: { used_percent: 20, window_minutes: 300 } }])("refuses missing or incomplete windows", limits => {
    const bad = { ...event(), payload: { type: "token_count", rate_limits: limits } };
    expect(usageFromRolloutEvents([bad], "default")).toEqual({ status: "unknown", reason: "inconsistent" });
  });
  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "30"]) ("refuses invalid percentages %s", used => {
    const bad = event(); Object.assign(bad.payload.rate_limits.primary, { used_percent: used });
    expect(usageFromRolloutEvents([bad], "default")).toEqual({ status: "unknown", reason: "inconsistent" });
  });
  it("does not fall back to older good evidence after malformed newest evidence", () => {
    const bad = { ...event(20, now + 1), payload: { type: "token_count", rate_limits: null } };
    expect(usageFromRolloutEvents([event(), bad], "default")).toEqual({ status: "unknown", reason: "inconsistent" });
  });
  it("validates a supplied known reading rather than trusting its type annotation", () => {
    const valid = observed();
    if (valid.status !== "known") throw new Error("fixture did not parse");
    const invalidTimestamp = { status: "known" as const, reading: { ...valid.reading, written_at: NaN } };
    expect(quotaAdmission(invalidTimestamp, now)).toMatchObject({ allowed: false, reason: "inconsistent" });
    const invalidCounter = { status: "known" as const, reading: { ...valid.reading,
      rate_limits: { ...valid.reading.rate_limits, five_hour: { ...valid.reading.rate_limits.five_hour, used_percentage: NaN } } } };
    expect(quotaAdmission(invalidCounter, now)).toMatchObject({ allowed: false, reason: "inconsistent" });
  });
  it("refuses future and reset-expired supplied observations", () => {
    expect(quotaAdmission(observed(20, now + 1), now)).toEqual({ allowed: false, reason: "inconsistent" });
    expect(quotaAdmission(observed(), now + 3000)).toEqual({ allowed: false, reason: "inconsistent" });
  });
  it("distinguishes conflicts and missing timestamps from absent quota", () => {
    for (const events of [[event(20), event(90)], [{ ...event(), timestamp: undefined }]]) {
      expect(usageFromRolloutEvents(events, "default")).toEqual({ status: "unknown", reason: "inconsistent" });
    }
    expect(usageFromRolloutEvents([], "default")).toEqual({ status: "unknown", reason: "missing" });
  });
  it("identifies windows by duration rather than position", () => {
    const original = event();
    const { primary, secondary } = original.payload.rate_limits;
    const swapped = { ...original, payload: { type: "token_count", rate_limits: { primary: secondary, secondary: primary } } };
    expect(validateRolloutWindows(swapped.payload.rate_limits, now)).toEqual({
      five_hour: { used_percentage: primary.used_percent, resets_at: primary.resets_at },
      seven_day: { used_percentage: secondary.used_percent, resets_at: secondary.resets_at },
    });
    expect(usageFromRolloutEvents([swapped], "default")).toEqual({ status: "unknown", reason: "freshness-unverified" });
  });
  it("refuses unknown pools, duration changes and millisecond reset values", () => {
    for (const change of [{ limit_id: "future-pool" },
      { primary: { used_percent: 10, window_minutes: 18000, resets_at: now + 1000 } },
      { primary: { used_percent: 10, window_minutes: 300, resets_at: (now + 1000) * 1000 } }]) {
      const bad = event(); Object.assign(bad.payload.rate_limits, change);
      expect(usageFromRolloutEvents([bad], "default")).toEqual({ status: "unknown", reason: "inconsistent" });
    }
  });
  it("ignores unrelated transcript content and catches hostile getters without leaking errors", () => {
    expect(usageFromRolloutEvents([{ type: "response_item", payload: "secret" }], "default").status).toBe("unknown");
    const hostile = { get type() { throw new Error("private-token"); } };
    expect(JSON.stringify(usageFromRolloutEvents([hostile], "default"))).not.toContain("private");
  });
  it("makes safe labels and redacts OpenAI tokens plus existing Titan secret formats", () => {
    expect(accountLabel("/tmp/.codex/")).toBe("default");
    expect(accountLabel("/tmp/reporter")).toBe("reporter");
    expect(() => accountLabel("/tmp/bad|label")).toThrow();
    expect(redactSecrets("sk-proj-exampleSecret access_token=hidden Bearer hidden"))
      .not.toMatch(/exampleSecret|hidden/);
    const error = new Error("sk-proj-exampleSecret", { cause: "hidden" });
    const redacted = redactSecrets(error);
    expect(redacted.message).not.toContain("exampleSecret");
    expect(redacted.cause).toBeUndefined();
  });
});
