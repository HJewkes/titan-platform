import { readAccounts } from "@titan-design/anthropic-account/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeAccountHome, writeAccountHome } from "./account-home.js";
import { FIXTURE_ACCOUNTS, HEALTH_JSON, NOW_MS, ROSTER_JSON, STATUS_LINES } from "./fixture.js";
import { accountUsageOf, parseRoster, parseSlots, parseStatusLine } from "./inputs.js";

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

describe("accountUsageOf over readAccounts", () => {
  let home: string;
  beforeEach(() => {
    home = writeAccountHome();
  });
  afterEach(() => removeAccountHome(home));

  const read = () => readAccounts({ home, env: {}, now: NOW_MS, platform: "linux", uid: process.getuid?.() ?? 0 }).map(accountUsageOf);

  it("keeps both windows, the reading age and the stale flag of each login in a temp home", () => {
    const byDir = (suffix: string) => read().find((row) => row.configDirs.some((dir) => dir.endsWith(suffix)));

    expect(byDir("acct-a")).toMatchObject({ fiveHour: { usedPct: 62 }, sevenDay: { usedPct: 21 }, ageSeconds: 40, stale: false, authFail: false });
    expect(byDir("acct-b")).toMatchObject({ stale: true, fiveHour: { usedPct: 91, resetsAtMs: null } });
    expect(byDir("/.claude")).toMatchObject({ fiveHour: null, ageSeconds: null, authFail: false });
  });

  it("matches the fixture accounts the panel renders, apart from the home path", () => {
    const strip = (rows: typeof FIXTURE_ACCOUNTS) => rows.map(({ configDirs, ...rest }) => ({ chips: configDirs.map((d) => d.split("/").pop()), ...rest }));

    expect(strip(read()).sort((a, b) => String(a.chips).localeCompare(String(b.chips)))).toEqual(
      strip(FIXTURE_ACCOUNTS).sort((a, b) => String(a.chips).localeCompare(String(b.chips))),
    );
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
