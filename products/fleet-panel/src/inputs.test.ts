import { describe, expect, it } from "vitest";
import { ACCOUNTS_JSON, HEALTH_JSON, ROSTER_JSON, STATUS_LINES } from "./fixture.js";
import { parseAccounts, parseRoster, parseSlots, parseStatusLine } from "./inputs.js";

describe("parseRoster", () => {
  it("reads every agent with its account dir, presence and transcript context", () => {
    const roster = parseRoster(ROSTER_JSON);

    expect(roster.map((entry) => entry.name)).toEqual(["builder-a", "reviewer-b", "planner-c", "fixer-d", "old-e"]);
    expect(roster[0]).toMatchObject({ presence: "live", configDir: "/home/you/.claude-profiles/acct-a", contextK: 88 });
    expect(roster[3]?.exitedAtMs).toBeTypeOf("number");
  });

  it("drops a row with no name or spawn time instead of failing the roster", () => {
    const roster = parseRoster(JSON.stringify([{ name: "ok", spawnedAt: "2026-01-01T00:00:00Z" }, { presence: "live" }, 7]));

    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ name: "ok", presence: "detached", model: null, configDir: null, contextK: null });
  });

  it("refuses output that is not an array", () => {
    expect(() => parseRoster("{}")).toThrow(/array/);
  });
});

describe("parseAccounts", () => {
  it("keeps both windows, the reading age and the stale flag", () => {
    const [first, second, third] = parseAccounts(ACCOUNTS_JSON);

    expect(first).toMatchObject({ fiveHour: { usedPct: 62 }, sevenDay: { usedPct: 21 }, ageSeconds: 40, stale: false });
    expect(second).toMatchObject({ stale: true, fiveHour: { usedPct: 91, resetsAtMs: null } });
    expect(third).toMatchObject({ fiveHour: null, ageSeconds: null });
  });
});

describe("parseStatusLine", () => {
  it("reads context fill and session cost with the write time in ms", () => {
    expect(parseStatusLine(STATUS_LINES["s-builder-a"] ?? "")).toMatchObject({ contextPct: 44, costUsd: 4.1 });
  });

  it("is null for a reading with no write time", () => {
    expect(parseStatusLine(JSON.stringify({ context: { used_pct: 3 } }))).toBeNull();
  });
});

describe("parseSlots", () => {
  it("reads held and cap from /health, and null when the broker sent none", () => {
    expect(parseSlots(HEALTH_JSON)).toEqual({ held: 3, cap: 12 });
    expect(parseSlots(JSON.stringify({ ok: true }))).toBeNull();
  });
});
