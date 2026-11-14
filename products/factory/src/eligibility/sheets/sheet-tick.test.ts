import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../../cli.js";
import { enabledRules, fakeRpc, readRows, selectedBet, shadowHome, shadowTickCli, task } from "../shadow/tick.test-helpers.js";
import { betLines, DIGEST, sheetText } from "./bet-sheet.test-helpers.js";

/*
 * The tick's proposed-sheet basis (TP-5755 S7): with no selected bet for the week, a lane is judged against its bet
 * sheet's proposed bets, and every row says so. One selected bet in the store keeps the selected basis.
 */

const W47 = "2026-11-18T12:00:00Z";
const W46 = "2026-11-11T12:00:00Z";

const SHEET = sheetText({ bets: [betLines("S1", 1, { tasks: "[alpha/AL-1]" }), betLines("S2", 2, { tasks: "[]" })] });

/** Sheet-only tasks: none names a bet, so each needs the relax list's `bet-field` to be admitted by a sheet bet's list. */
const tasks = [task(1, { bet: undefined }), task(2, { bet: undefined })];

function sheetHome(bets: Record<string, unknown> = {}, sheet = SHEET) {
  const home = shadowHome();
  const sheetDir = join(home.dir, "bets");
  mkdirSync(sheetDir);
  mkdirSync(join(home.dir, "digests"));
  writeFileSync(join(sheetDir, "web.md"), sheet);
  writeFileSync(join(home.dir, "digests", "web.md"), DIGEST);
  const rules = enabledRules(home, { relax: ["bet-field"], bets: { source: "selected-then-sheet", sheetDir, ...bets } });
  writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(rules));
  return home;
}

const laneRows = (home: { shadowDir: string }) => readRows(home.shadowDir)[0]!.rows.filter((row) => row.kind !== "wake");

const at = (now: string) => void vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(now) });

describe("shadow tick proposed-sheet basis", () => {
  afterEach(() => void vi.useRealTimers());

  it("an empty store falls back to the lane's sheet, labels every row, and lets a sheet task through bet-field", async () => {
    at(W47);
    const home = sheetHome();

    const { code } = await shadowTickCli(home, fakeRpc({ tasks, bets: [] }).fetch);

    expect(code).toBe(EXIT.OK);
    expect(laneRows(home)).toEqual([
      expect.objectContaining({ kind: "refused", task: "alpha/AL-2", basis: "proposed-sheet", stage: "eligibility", codes: ["no-bet"] }),
      expect.objectContaining({ kind: "would-dispatch", task: "alpha/AL-1", basis: "proposed-sheet", bet: "alpha/S1", relaxed: ["bet-field"], strict_codes: ["no-bet"] }),
    ]);
    expect(laneRows(home).some((row) => "sheet_week" in row)).toBe(false);
  });

  it("one selected bet in the store keeps the selected basis and ignores the sheet", async () => {
    at(W47);
    const home = sheetHome();

    await shadowTickCli(home, fakeRpc({ tasks: [task(3)], bets: [selectedBet(1, 1, ["alpha/AL-3"])] }).fetch);

    expect(laneRows(home)).toEqual([expect.objectContaining({ kind: "would-dispatch", task: "alpha/AL-3", basis: "selected", bet: "alpha/B1" })]);
  });

  it("the selected source never reads a sheet", async () => {
    at(W47);
    const home = sheetHome({ source: "selected" });

    await shadowTickCli(home, fakeRpc({ tasks, bets: [] }).fetch);

    expect(laneRows(home).map((row) => [row.basis, row.task, row.kind])).toEqual([
      ["selected", "alpha/AL-1", "refused"],
      ["selected", "alpha/AL-2", "refused"],
    ]);
  });

  it("a daemon without plan.* reads the store from files, and an empty store still falls back to the sheet", async () => {
    at(W47);
    const home = sheetHome();

    await shadowTickCli(home, fakeRpc({ tasks, bets: [], plan: "unknown" }).fetch);

    const [wake, ...rows] = readRows(home.shadowDir)[0]!.rows;
    expect(wake).toMatchObject({ kind: "wake", plan_read: "file" });
    expect(rows.find((row) => row.task === "alpha/AL-1")).toMatchObject({ kind: "would-dispatch", basis: "proposed-sheet" });
  });

  it("sheets of a later week are unused in the calendar week before it, unless the rule file pins that week", async () => {
    at(W46);
    const unpinned = sheetHome();
    const pinned = sheetHome({ sheetWeek: "2026-W47" });

    await shadowTickCli(unpinned, fakeRpc({ tasks, bets: [] }).fetch);
    await shadowTickCli(pinned, fakeRpc({ tasks, bets: [] }).fetch);

    expect(laneRows(unpinned).map((row) => row.basis)).toEqual(["selected", "selected"]);
    expect(laneRows(pinned).find((row) => row.task === "alpha/AL-1")).toMatchObject({ kind: "would-dispatch", basis: "proposed-sheet", week: "2026-W46", sheet_week: "2026-W47" });
    expect(laneRows(pinned).every((row) => row.sheet_week === "2026-W47")).toBe(true);
  });

  it("a sheet that does not parse refuses its lane with one task-less row instead of judging against no bets", async () => {
    at(W47);
    const home = sheetHome({}, sheetText({ bets: [betLines("S1", 1, { prediction: null })] }));

    const { code } = await shadowTickCli(home, fakeRpc({ tasks, bets: [] }).fetch);

    expect(code).toBe(EXIT.OK);
    expect(laneRows(home)).toEqual([expect.objectContaining({ kind: "refused", task: null, basis: "proposed-sheet", stage: "eligibility", codes: ["sheet-unreadable"], details: [expect.stringMatching(/^bet sheet web\.md does not parse: line \d+: /)] })]);
  });

  it("a broken sheet does not touch a lane the owner has selected bets for", async () => {
    at(W47);
    const home = sheetHome({}, "not a sheet");

    await shadowTickCli(home, fakeRpc({ tasks: [task(3)], bets: [selectedBet(1, 1, ["alpha/AL-3"])] }).fetch);

    expect(laneRows(home)).toEqual([expect.objectContaining({ kind: "would-dispatch", task: "alpha/AL-3", basis: "selected" })]);
  });
});
