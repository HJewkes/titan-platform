import { describe, expect, it } from "vitest";
import { botTokenExpiryWatch, parseTokenExpiration } from "./bot-token-expiry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-21T12:00:00Z");
const FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);

/** GitHub's own shape for the header: `YYYY-MM-DD HH:MM:SS UTC`. */
function expirationHeader(at: number): Headers {
  const header = new Date(at).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return new Headers({ "github-authentication-token-expiration": header });
}

function watch(fingerprint = FINGERPRINT, alarmed = new Set<string>()) {
  const lines: string[] = [];
  return { lines, watch: botTokenExpiryWatch({ fingerprint, now: () => NOW, log: (line) => lines.push(line), alarmed }) };
}

describe("parseTokenExpiration", () => {
  it("reads GitHub's UTC form", () => {
    expect(parseTokenExpiration("2026-11-04 12:00:00 UTC")).toBe(Date.parse("2026-11-04T12:00:00Z"));
  });

  it("reads a numeric offset form", () => {
    expect(parseTokenExpiration("2026-11-04 04:00:00 -0800")).toBe(Date.parse("2026-11-04T12:00:00Z"));
  });

  it("reads anything else as no expiry rather than guessing", () => {
    expect(parseTokenExpiration("next tuesday")).toBeUndefined();
    expect(parseTokenExpiration("2026-13-45 99:00:00 UTC")).toBeUndefined();
  });
});

describe("bot token expiry alarm (V7)", () => {
  it("raises no alarm with 15 days left, but records the expiry", () => {
    const { lines, watch: expiry } = watch();

    expiry.observe(expirationHeader(NOW + 15 * DAY_MS));

    expect(lines).toEqual([]);
    expect(expiry.expiresAt()).toBe(new Date(NOW + 15 * DAY_MS).toISOString());
  });

  it("raises one ops alarm with 14 days left, naming the fingerprint's prefix and never more of it", () => {
    const { lines, watch: expiry } = watch();

    expiry.observe(expirationHeader(NOW + 14 * DAY_MS));

    expect(lines).toEqual([`factory: ops-alarm bot-token-expiry fingerprint=${FINGERPRINT.slice(0, 12)} expiresAt=2026-11-04T12:00:00.000Z daysLeft=14`]);
  });

  it("raises the alarm once per fingerprint across responses and across watches", () => {
    const alarmed = new Set<string>();
    const first = watch(FINGERPRINT, alarmed);
    const second = watch(FINGERPRINT, alarmed);

    first.watch.observe(expirationHeader(NOW + 14 * DAY_MS));
    first.watch.observe(expirationHeader(NOW + 14 * DAY_MS));
    second.watch.observe(expirationHeader(NOW + 3 * DAY_MS));

    expect(first.lines).toHaveLength(1);
    expect(second.lines).toEqual([]);
  });

  it("raises a fresh alarm for a different token's fingerprint", () => {
    const alarmed = new Set<string>();
    const old = watch(FINGERPRINT, alarmed);
    const rotated = watch(OTHER_FINGERPRINT, alarmed);

    old.watch.observe(expirationHeader(NOW + 14 * DAY_MS));
    rotated.watch.observe(expirationHeader(NOW + 14 * DAY_MS));

    expect(rotated.lines).toHaveLength(1);
  });

  it("raises the alarm for a token already past its expiry", () => {
    const { lines, watch: expiry } = watch();

    expiry.observe(expirationHeader(NOW - DAY_MS));

    expect(lines).toEqual([expect.stringContaining("daysLeft=-1")]);
  });

  it("with no header, as for a token with no expiry, has no expiresAt and no alarm", () => {
    const { lines, watch: expiry } = watch();

    expiry.observe(new Headers());

    expect(expiry.expiresAt()).toBeNull();
    expect(lines).toEqual([]);
  });
});
