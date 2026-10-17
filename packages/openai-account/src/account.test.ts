import { describe, expect, it } from "vitest";
import { accountLabel, loginStateFromStatus, quotaAdmission, redactSecrets, usageFromRolloutEvents, type UsageResult } from "./index.js";

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

describe("read-only Codex account core", () => {
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
  it("maps only numeric windows, preserving evidence age and account label", () => {
    const result = usageFromRolloutEvents([event()], "reporter");
    expect(result).toEqual({ status: "known", reading: { account: "reporter", written_at: now,
      rate_limits: { five_hour: { used_percentage: 20, resets_at: now + 1000 },
        seven_day: { used_percentage: 70, resets_at: now + 2000 } } } });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(quotaAdmission(result, now + 12)).toEqual({ allowed: true, ageSeconds: 12 });
  });
  it("uses observation timestamps across files rather than traversal order", () => {
    const result = usageFromRolloutEvents([event(95, now), event(20, now - 60)], "default");
    expect(quotaAdmission(result, now)).toMatchObject({ allowed: false, reason: "weekly-reserve" });
  });
  it("accepts native ISO timestamps with millisecond precision without rejuvenating them", () => {
    const result = usageFromRolloutEvents([event(20, now + 0.123)], "default");
    expect(quotaAdmission(result, now + 1)).toEqual({ allowed: true, ageSeconds: expect.closeTo(0.877) });
  });
  it.each([[86, true], [86.001, false], [100, false]])("weekly used %s admission=%s", (used, allowed) => {
    expect(quotaAdmission(usageFromRolloutEvents([event(used)], "default"), now).allowed).toBe(allowed);
  });
  it("refuses five-hour ceiling and stale evidence; exact age boundary is allowed", () => {
    const result = usageFromRolloutEvents([event()], "default");
    expect(quotaAdmission(result, now + 900).allowed).toBe(true);
    expect(quotaAdmission(result, now + 901)).toMatchObject({ allowed: false, reason: "stale" });
    const full = event(); full.payload.rate_limits.primary.used_percent = 100;
    expect(quotaAdmission(usageFromRolloutEvents([full], "default"), now)).toMatchObject({ allowed: false, reason: "five-hour-ceiling" });
  });
  it.each([null, {}, { primary: { used_percent: 20, window_minutes: 300 } }])("refuses missing or incomplete windows", limits => {
    const bad = { ...event(), payload: { type: "token_count", rate_limits: limits } };
    expect(quotaAdmission(usageFromRolloutEvents([bad], "default"), now).allowed).toBe(false);
  });
  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "30"]) ("refuses invalid percentages %s", used => {
    const bad = event(); Object.assign(bad.payload.rate_limits.primary, { used_percent: used });
    expect(quotaAdmission(usageFromRolloutEvents([bad], "default"), now).allowed).toBe(false);
  });
  it("does not fall back to older good evidence after malformed newest evidence", () => {
    const bad = { ...event(20, now + 1), payload: { type: "token_count", rate_limits: null } };
    expect(quotaAdmission(usageFromRolloutEvents([event(), bad], "default"), now + 1).allowed).toBe(false);
  });
  it("validates a supplied known reading rather than trusting its type annotation", () => {
    const valid = usageFromRolloutEvents([event()], "default");
    if (valid.status !== "known") throw new Error("fixture did not parse");
    const malformed: UsageResult = { status: "known", reading: { ...valid.reading, written_at: NaN } };
    expect(quotaAdmission(malformed, now)).toMatchObject({ allowed: false, reason: "inconsistent" });
    valid.reading.rate_limits.five_hour.used_percentage = NaN;
    expect(quotaAdmission(valid, now)).toMatchObject({ allowed: false, reason: "inconsistent" });
  });
  it("refuses future, reset-expired, conflicting and timestamp-less evidence", () => {
    for (const events of [[event(20, now + 1)], [event(20, now - 3000)], [event(20), event(90)], [{ ...event(), timestamp: undefined }]]) {
      expect(quotaAdmission(usageFromRolloutEvents(events, "default"), now).allowed).toBe(false);
    }
    expect(quotaAdmission(usageFromRolloutEvents([], "default"), now).allowed).toBe(false);
  });
  it("identifies windows by duration rather than position", () => {
    const original = event();
    const { primary, secondary } = original.payload.rate_limits;
    const swapped = { ...original, payload: { type: "token_count", rate_limits: { primary: secondary, secondary: primary } } };
    expect(usageFromRolloutEvents([swapped], "default")).toEqual(usageFromRolloutEvents([original], "default"));
  });
  it("refuses unknown pools, duration changes and millisecond reset values", () => {
    for (const change of [{ limit_id: "future-pool" },
      { primary: { used_percent: 10, window_minutes: 18000, resets_at: now + 1000 } },
      { primary: { used_percent: 10, window_minutes: 300, resets_at: (now + 1000) * 1000 } }]) {
      const bad = event(); Object.assign(bad.payload.rate_limits, change);
      expect(quotaAdmission(usageFromRolloutEvents([bad], "default"), now).allowed).toBe(false);
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
