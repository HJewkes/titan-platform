import { describe, expect, it } from "vitest";
import {
  CANARY,
  FAKE_ACCESS_TOKEN,
  FAKE_REFRESH_TOKEN,
  HOUR,
  NOW,
  fakeCredentials,
} from "./fixtures/fake-tokens.js";
import { loginStateFromCredentials, needsRefresh, type LoginState } from "./login.js";

describe("loginStateFromCredentials", () => {
  it("reports a live login with its expiry and plan, and no token", () => {
    expect(loginStateFromCredentials(fakeCredentials(), NOW)).toEqual({
      status: "present",
      expiresAt: NOW + 2 * HOUR,
      canRefresh: true,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });
  });

  it("reports an access token at or past its expiry as expired", () => {
    expect(loginStateFromCredentials(fakeCredentials({ expiresAt: NOW }), NOW)).toEqual({
      status: "expired",
      expiresAt: NOW,
      canRefresh: true,
    });
  });

  it.each([
    ["no refresh token", { refreshToken: undefined }],
    ["an expired refresh token", { refreshTokenExpiresAt: NOW - 1 }],
  ])("cannot refresh with %s", (_case, overrides) => {
    expect(loginStateFromCredentials(fakeCredentials(overrides), NOW)).toMatchObject({ canRefresh: false });
  });

  it("can refresh when the refresh token has no recorded expiry", () => {
    const state = loginStateFromCredentials(fakeCredentials({ refreshTokenExpiresAt: null }), NOW);

    expect(state).toMatchObject({ canRefresh: true });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an object with no OAuth block", { mcpOAuth: {} }],
    ["a null OAuth block", { claudeAiOauth: null }],
    ["an OAuth block only on the prototype", Object.create(fakeCredentials()) as unknown],
  ])("reports missing for %s", (_case, credentials) => {
    expect(loginStateFromCredentials(credentials, NOW)).toEqual({ status: "missing" });
  });

  it.each([
    ["no access token", { accessToken: undefined }],
    ["an empty access token", { accessToken: "" }],
    ["an expiry in seconds", { expiresAt: Math.floor(NOW / 1000) }],
    ["an expiry in microseconds", { expiresAt: NOW * 1000 }],
    ["a refresh expiry in microseconds", { refreshTokenExpiresAt: NOW * 1000 }],
    ["an expiry that is a string", { expiresAt: String(NOW) }],
  ])("refuses credentials with %s as malformed", (_case, overrides) => {
    expect(loginStateFromCredentials(fakeCredentials(overrides), NOW)).toEqual({
      status: "refused",
      reason: "malformed",
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects a now of %s rather than reading every login as live", (now) => {
    expect(() => loginStateFromCredentials(fakeCredentials(), now)).toThrow(
      new RangeError("now must be a finite epoch-ms time"),
    );
  });

  it("drops a plan label that is token-shaped", () => {
    const credentials = fakeCredentials({ subscriptionType: FAKE_ACCESS_TOKEN, rateLimitTier: "x".repeat(65) });

    const state = loginStateFromCredentials(credentials, NOW);

    expect(state).toEqual({ status: "present", expiresAt: NOW + 2 * HOUR, canRefresh: true });
  });
});

const hostileGetter = {
  get claudeAiOauth(): never {
    throw new Error(`could not read ${FAKE_ACCESS_TOKEN}`);
  },
};

const secretCases: [string, unknown][] = [
  ["present", fakeCredentials()],
  ["expired", fakeCredentials({ expiresAt: NOW - HOUR })],
  ["a token in every string field", fakeCredentials({ subscriptionType: FAKE_REFRESH_TOKEN, rateLimitTier: FAKE_ACCESS_TOKEN })],
  ["a token as the expiry", fakeCredentials({ expiresAt: FAKE_ACCESS_TOKEN })],
  ["a token as the refresh expiry", fakeCredentials({ refreshTokenExpiresAt: FAKE_REFRESH_TOKEN })],
  ["a token as the whole OAuth block", { claudeAiOauth: FAKE_ACCESS_TOKEN }],
  ["a getter that throws a token", hostileGetter],
];

describe("no secret leaves loginStateFromCredentials", () => {
  it.each(secretCases)("returns without a token for %s", (_case, credentials) => {
    const state = loginStateFromCredentials(credentials, NOW);

    expect(JSON.stringify(state)).not.toContain(CANARY);
    expect(Object.values(state).map(String).join(" ")).not.toContain(CANARY);
  });

  it.each(secretCases)("does not throw for %s", (_case, credentials) => {
    expect(() => loginStateFromCredentials(credentials, NOW)).not.toThrow();
  });

  it("has no key that could hold a token in any state", () => {
    const keys = secretCases.flatMap(([, credentials]) => Object.keys(loginStateFromCredentials(credentials, NOW)));

    expect(keys.filter((key) => /token|secret|auth/i.test(key))).toEqual([]);
  });
});

describe("needsRefresh", () => {
  const present = (expiresAt: number): LoginState => ({ status: "present", expiresAt, canRefresh: true });

  it.each([
    ["well before the margin", present(NOW + 2 * HOUR), 5 * 60_000, false],
    ["inside the margin", present(NOW + 60_000), 5 * 60_000, true],
    ["exactly at the margin", present(NOW + 5 * 60_000), 5 * 60_000, true],
    ["with a zero margin before expiry", present(NOW + 1), 0, false],
    ["already expired", { status: "expired", expiresAt: NOW - 1, canRefresh: true } as const, 0, true],
    ["missing", { status: "missing" } as const, 5 * 60_000, false],
    ["refused", { status: "refused", reason: "malformed" } as const, 5 * 60_000, false],
  ])("decides a state %s", (_case, state, marginMs, expected) => {
    expect(needsRefresh(state, NOW, marginMs)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a margin of %s", (marginMs) => {
    expect(() => needsRefresh(present(NOW + HOUR), NOW, marginMs)).toThrow(RangeError);
  });

  it("always wants a refresh for an expired state, even judged from an earlier now", () => {
    const expired: LoginState = { status: "expired", expiresAt: NOW - 1000, canRefresh: true };

    expect(needsRefresh(expired, NOW - HOUR, 0)).toBe(true);
  });

  it("rejects a now that is not finite", () => {
    expect(() => needsRefresh(present(NOW + HOUR), Number.NaN, 0)).toThrow(RangeError);
  });
});
