import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRuleFilePath, loadRuleFile } from "./rule-file.js";

function ruleFile(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "rule-file-")), "dispatcher.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

const minimal = { schema: "titan-dispatcher/v1", mode: "shadow" };

describe("dispatcher rule file", () => {
  it("an absent file loads as nothing", () => {
    expect(loadRuleFile(join(tmpdir(), "no-such-dir-for-rule-file", "dispatcher.json"))).toBeUndefined();
  });

  it("a minimal file takes shadow off and no lanes, and names its hash", () => {
    const loaded = loadRuleFile(ruleFile(minimal));

    expect(loaded?.rules).toMatchObject({ shadow: { enabled: false }, lanes: [] });
    expect(loaded?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses any mode but shadow, so no value expresses live dispatch", () => {
    expect(() => loadRuleFile(ruleFile({ ...minimal, mode: "live" }))).toThrow(/mode/);
  });

  it("refuses an enabled shadow with no dir", () => {
    expect(() => loadRuleFile(ruleFile({ ...minimal, shadow: { enabled: true } }))).toThrow(/an enabled shadow needs a dir/);
  });

  it("refuses a sheet bet source with no sheet dir, and a sheet week that is not an ISO week", () => {
    expect(() => loadRuleFile(ruleFile({ ...minimal, bets: { source: "selected-then-sheet" } }))).toThrow(/a sheet bet source needs a sheetDir/);
    expect(() => loadRuleFile(ruleFile({ ...minimal, bets: { source: "selected-then-sheet", sheetDir: "/s", sheetWeek: "2026-47" } }))).toThrow(/bets\.sheetWeek/);
  });

  it("refuses an unplanned key, and names the file when it is not JSON", () => {
    expect(() => loadRuleFile(ruleFile({ ...minimal, dispatchLive: true }))).toThrow(/dispatchLive/);
    const broken = ruleFile("{ not json");

    expect(() => loadRuleFile(broken)).toThrow(broken);
  });

  it("parses the plan's full example, keys of later slices included, with a lane tag defaulting to null", () => {
    const example = {
      ...minimal,
      shadow: { enabled: false, dir: "/var/tmp/shadow" },
      lanes: [{ initiative: "alpha", tag: "lane-a" }, { initiative: "beta" }],
      bets: { source: "selected-then-sheet", sheetDir: "/var/tmp/bets" },
      relax: ["bet-field", "no-fold", "no-owner-steps"],
      intake: { minSeverity: "medium", expireDays: 28 },
      upkeep: { capShare: 0.25, windowDays: 7 },
      stop: { taskFixRounds: 3, spendMultiple: 2, usdPerPoint: 8, betStoppedPrs: 3, betFollowupMultiple: 2, checkpointEvery: 5 },
    };

    expect(loadRuleFile(ruleFile(example))?.rules.lanes).toEqual([
      { initiative: "alpha", tag: "lane-a" },
      { initiative: "beta", tag: null },
    ]);
  });

  it("relax defaults to none and intake to medium severity over 28 days, and a partial intake keeps the other default", () => {
    expect(loadRuleFile(ruleFile(minimal))?.rules).toMatchObject({ relax: [], intake: { minSeverity: "medium", expireDays: 28 } });
    expect(loadRuleFile(ruleFile({ ...minimal, intake: { expireDays: 14 } }))?.rules.intake).toEqual({ minSeverity: "medium", expireDays: 14 });
  });

  it("refuses a relax entry or a severity outside the closed sets", () => {
    expect(() => loadRuleFile(ruleFile({ ...minimal, relax: ["no-done-when"] }))).toThrow(/relax/);
    expect(() => loadRuleFile(ruleFile({ ...minimal, intake: { minSeverity: "trivial" } }))).toThrow(/minSeverity/);
  });

  it("fills each absent stop threshold with its starting value, and refuses a zero cap", () => {
    expect(loadRuleFile(ruleFile(minimal))?.rules.stop).toEqual({ taskFixRounds: 3, spendMultiple: 2, usdPerPoint: 8, betStoppedPrs: 3, betFollowupMultiple: 2, checkpointEvery: 5 });
    expect(loadRuleFile(ruleFile({ ...minimal, stop: { taskFixRounds: 4 } }))?.rules.stop).toMatchObject({ taskFixRounds: 4, checkpointEvery: 5 });
    expect(() => loadRuleFile(ruleFile({ ...minimal, stop: { checkpointEvery: 0 } }))).toThrow(/stop\.checkpointEvery/);
  });

  it("reads a lane's ready-stock floor and coordinator, and refuses a zero floor or a coordinator that is no peer name", () => {
    const lanes = [{ initiative: "alpha", tag: "lane-a", floor: 20, coordinator: "alpha-coord" }];

    expect(loadRuleFile(ruleFile({ ...minimal, lanes }))?.rules.lanes).toEqual(lanes);
    expect(() => loadRuleFile(ruleFile({ ...minimal, lanes: [{ initiative: "alpha", floor: 0 }] }))).toThrow(/lanes\.0\.floor/);
    expect(() => loadRuleFile(ruleFile({ ...minimal, lanes: [{ initiative: "alpha", coordinator: "Alpha Coord" }] }))).toThrow(/must be an agent-chat peer name/);
  });

  it("sits beside the factory config.json by default", () => {
    expect(defaultRuleFilePath({ TITAN_FACTORY_CONFIG: "/etc/factory/config.json" })).toBe("/etc/factory/dispatcher.json");
    expect(defaultRuleFilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/titan-factory/dispatcher.json");
  });
});
