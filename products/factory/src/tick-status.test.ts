import { describe, expect, it } from "vitest";
import { judgeTick } from "./tick-status.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const FILE = "/srv/tester/.agent-chat/burndown-status.json";
const beat = (agoMs: number, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, loop: "burndown-tick", heartbeatAt: new Date(NOW - agoMs).toISOString(), outcome: "ok", consecutiveFailures: 0, intervalSeconds: 600, ...over });

describe("judgeTick", () => {
  it("ignores an absent file", () => {
    expect(judgeTick({ file: FILE, text: undefined }, NOW)).toBeUndefined();
  });

  it.each(["", "not json", "[]", "null", JSON.stringify({ version: 2 }), beat(0, { intervalSeconds: 0 }), beat(0, { heartbeatAt: "nope" })])("ignores unusable text %j", (text) => {
    expect(judgeTick({ file: FILE, text }, NOW)).toBeUndefined();
  });

  it("does not call a heartbeat of exactly three intervals stale", () => {
    expect(judgeTick({ file: FILE, text: beat(1_800_000) }, NOW)).toBeUndefined();
  });

  it("treats a skipped tick that keeps a failure count as failing", () => {
    const problem = judgeTick({ file: FILE, text: beat(1000, { outcome: "skipped", consecutiveFailures: 3 }) }, NOW);

    expect(problem?.cause).toBe("tick failing");
  });

  it("reports a stale heartbeat ahead of an old failure count", () => {
    const problem = judgeTick({ file: FILE, text: beat(2_000_000, { outcome: "failed", consecutiveFailures: 4 }) }, NOW);

    expect(problem?.cause).toBe("tick stale");
  });

  it("replaces a credential-shaped class with Error", () => {
    const problem = judgeTick({ file: FILE, text: beat(1000, { outcome: "failed", consecutiveFailures: 1, lastErrorClass: `ghp_${"a".repeat(20)}` }) }, NOW);

    expect(problem?.detail.tickErrorClass).toBe("Error");
    expect(problem?.message).not.toContain("ghp_");
  });
});
