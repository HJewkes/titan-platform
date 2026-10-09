import { describe, expect, it } from "vitest";
import oauthUsage from "./fixtures/oauth-usage.json" with { type: "json" };
import { CANARY, FAKE_ACCESS_TOKEN, FAKE_JWT } from "./fixtures/fake-tokens.js";
import { parseUsageReading, usageFromOAuthResponse } from "./usage.js";

const WRITTEN_AT = 1_791_460_800;

describe("parseUsageReading", () => {
  const statusLine = {
    session_id: "3f0c2b9e-session",
    written_at: WRITTEN_AT,
    rate_limits: {
      five_hour: { used_percentage: 12, resets_at: 1_791_475_200 },
      seven_day: { used_percentage: 40.5, resets_at: 1_791_806_400 },
    },
  };

  it("accepts the status-line document Claude Code's budget writer stores", () => {
    expect(parseUsageReading(statusLine)).toEqual(statusLine);
  });

  it("keeps a window that has no reset time", () => {
    const reading = { ...statusLine, rate_limits: { five_hour: { used_percentage: 0 } } };

    expect(parseUsageReading(reading)?.rate_limits.five_hour).toEqual({ used_percentage: 0 });
  });

  it.each([
    ["no session id", { ...statusLine, session_id: undefined }],
    ["no written_at", { ...statusLine, written_at: undefined }],
    ["a string percentage", { ...statusLine, rate_limits: { five_hour: { used_percentage: "12" } } }],
    ["a negative percentage", { ...statusLine, rate_limits: { five_hour: { used_percentage: -1 } } }],
    ["a non-object", "five_hour=12"],
    ["null", null],
  ])("returns null for %s", (_case, input) => {
    expect(parseUsageReading(input)).toBeNull();
  });

  it("drops keys it does not know", () => {
    const reading = parseUsageReading({ ...statusLine, accessToken: FAKE_ACCESS_TOKEN });

    expect(JSON.stringify(reading)).not.toContain(CANARY);
  });
});

describe("usageFromOAuthResponse", () => {
  it("maps the documented usage response into the status-line shape", () => {
    const reading = usageFromOAuthResponse(oauthUsage, { writtenAt: WRITTEN_AT, account: "agents" });

    expect(reading).toEqual({
      session_id: "usage-poll",
      written_at: WRITTEN_AT,
      source: "oauth-usage",
      account: "agents",
      rate_limits: {
        five_hour: { used_percentage: 23, resets_at: Date.UTC(2026, 9, 8, 17, 0, 0) / 1000 },
        seven_day: { used_percentage: 41.5, resets_at: Date.UTC(2026, 9, 12, 9, 0, 0) / 1000 },
        seven_day_opus: { used_percentage: 0 },
      },
    });
  });

  it("produces a reading parseUsageReading accepts", () => {
    const reading = usageFromOAuthResponse(oauthUsage, { writtenAt: WRITTEN_AT });

    expect(parseUsageReading(reading)).toEqual(reading);
  });

  it("keeps an unfamiliar window that has the window shape", () => {
    const body = { seven_day_sonnet: { utilization: 5, resets_at: "2026-10-12T09:00:00Z" } };

    expect(usageFromOAuthResponse(body, { writtenAt: WRITTEN_AT })?.rate_limits).toHaveProperty("seven_day_sonnet");
  });

  it("omits the reset time when it is not a date", () => {
    const body = { five_hour: { utilization: 5, resets_at: "soon" } };

    expect(usageFromOAuthResponse(body, { writtenAt: WRITTEN_AT })?.rate_limits.five_hour).toEqual({
      used_percentage: 5,
    });
  });

  it.each([
    ["an error body", { error: { type: "authentication_error", message: "invalid token" } }],
    ["an empty object", {}],
    ["an array", [{ utilization: 1, resets_at: null }]],
    ["null", null],
    ["a string", "five_hour"],
  ])("returns null for %s", (_case, body) => {
    expect(usageFromOAuthResponse(body, { writtenAt: WRITTEN_AT })).toBeNull();
  });

  it("returns null instead of throwing when a body's getter throws a token", () => {
    const body = {
      get five_hour(): never {
        throw new Error(`leaked ${FAKE_ACCESS_TOKEN}`);
      },
    };

    expect(usageFromOAuthResponse(body, { writtenAt: WRITTEN_AT })).toBeNull();
  });

  it("lets no part of a hostile body other than a window reach the reading", () => {
    const body = {
      ...oauthUsage,
      [FAKE_ACCESS_TOKEN]: { utilization: 1, resets_at: null },
      [`five_hour_${CANARY.toLowerCase()}_${"a".repeat(40)}`]: { utilization: 1, resets_at: null },
      echo: { authorization: `Bearer ${FAKE_ACCESS_TOKEN}`, utilization: 1, resets_at: FAKE_JWT },
      seven_day: { utilization: 2, resets_at: FAKE_JWT, token: FAKE_ACCESS_TOKEN },
    };

    const serialized = JSON.stringify(usageFromOAuthResponse(body, { writtenAt: WRITTEN_AT }));

    expect(serialized).not.toContain(CANARY);
    expect(serialized.toLowerCase()).not.toContain(CANARY.toLowerCase());
  });
});
