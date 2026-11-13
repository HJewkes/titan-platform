import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, SCORECARD_MIGRATIONS, taskRow, upsertWeekRows, weekRows, type FactoryHealth, type TaskRow } from "@titan-design/session-analytics";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { emptyModel } from "../test-support/digest.js";
import { rankDigest } from "./rank.js";
import { renderMarkdown } from "./render-md.js";
import { readScorecard, scorecardLines, scorecardPaths, type ScorecardPaths } from "./scorecard.js";

let dir: string;
let paths: ScorecardPaths;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "digest-scorecard-"));
  paths = { storeFile: path.join(dir, "scorecard.sqlite3"), weeksDir: path.join(dir, "weeks") };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Monday 2031-03-10 13:00Z, the 06:00 Denver slot after the 2031-W10 close; its window opened at 01:00Z. */
const NOW = new Date("2031-03-10T13:00:00.000Z");
const SINCE = new Date("2031-03-10T01:00:00.000Z");
const CLOSED_AT = new Date("2031-03-10T12:45:00.000Z");

function metrics(overrides: Record<string, number | null>): Record<string, number | null> {
  return { dispatched: 15, merged: 13, upkeepShare: 0.4, ownerSourcedShare: 0.12, leadDispatchMergeMedianH: 5.5, costPerMerged: 6.8, inferredShare: 0.75, ...overrides };
}

function freeze(week: string, cellMetrics: Record<string, number | null>, redFlags: string[], at: Date = CLOSED_AT, extra: Record<string, unknown> = {}): void {
  mkdirSync(paths.weeksDir, { recursive: true });
  const file = path.join(paths.weeksDir, `${week}.json`);
  writeFileSync(file, JSON.stringify({ isoWeek: week, cells: [{ isoWeek: week, dimension: "all", key: "all", metrics: cellMetrics, redFlags }], phases: [], ...extra }));
  utimesSync(file, at, at);
}

function dispatched(taskId: string, ts: string): TaskRow {
  const row = taskRow({
    task: { initiative: "orbit-relay", taskId, createdAt: "2031-03-01T00:00:00.000Z", doneAt: null, estimate: 1 },
    spawns: [{ ts, actor: "orbit-coord", launchedBy: null, dispatchRule: null }],
    registrations: [], runs: [], gates: [], prs: [],
    labels: { class: { value: "product", origin: "recorded" } },
  });
  if (row === null) throw new Error("expected a dispatched task");
  return row;
}

/** The store as the job leaves it, holding the given dispatches' weekly cells. */
function storeWith(rows: readonly TaskRow[]): void {
  const db = openDatabase(paths.storeFile);
  runMigrations(db, SCORECARD_MIGRATIONS);
  upsertWeekRows(db, weekRows(rows, DEFAULT_THRESHOLDS), "2031-03-10T12:45:00.000Z");
  db.close();
}

const digestOf = (section: ReturnType<typeof readScorecard>): string => renderMarkdown(rankDigest(emptyModel({ scorecard: section })));

describe("the ticket scorecard in the digest", () => {
  it("digest weekly slot prints six headline numbers", () => {
    freeze("2031-W10", metrics({}), ["upkeep-cap"]);

    const lines = scorecardLines(readScorecard(paths, NOW, SINCE));

    expect(lines.slice(1, 3)).toEqual(["## Ticket scorecard 2031-W10", "Red flags: upkeep over cap"]);
    expect(lines.filter((line) => line.startsWith("- "))).toEqual([
      "- Dispatched: 15",
      "- Merged: 13",
      "- Upkeep share: 40% (inferred labels)",
      "- Owner-sourced: 12% (inferred labels)",
      "- Dispatch to merge, median: 5.5h",
      "- Cost per merged task: $6.80",
    ]);
  });

  it("digest reads frozen week file only", () => {
    freeze("2031-W10", metrics({ dispatched: 15 }), []);
    storeWith([dispatched("OR-1", "2031-03-05T10:00:00.000Z")]);

    const markdown = digestOf(readScorecard(paths, NOW, SINCE));

    expect(markdown).toContain("- Dispatched: 15");
    expect(markdown).not.toContain("- Dispatched: 1\n");
  });

  it("prints the open week's one line when the close happened before this slot's window", () => {
    freeze("2031-W10", metrics({}), ["upkeep-cap"], new Date("2031-03-09T23:00:00.000Z"));
    storeWith([dispatched("OR-2", "2031-03-10T09:00:00.000Z")]);

    const lines = scorecardLines(readScorecard(paths, NOW, SINCE));

    expect(lines).toEqual(["", "Ticket scorecard 2031-W11 so far: 1 dispatched, 0 merged, upkeep 0%."]);
  });

  it("says not measured, never zero, when the host has no scorecard store", () => {
    const lines = scorecardLines(readScorecard(paths, NOW, SINCE));

    expect(lines).toEqual(["", "Ticket scorecard 2031-W11 so far: not measured (no scorecard store on this host)."]);
  });

  it("shows an unmeasured headline figure as not measured", () => {
    freeze("2031-W10", metrics({ costPerMerged: null, inferredShare: 0 }), []);

    const lines = scorecardLines(readScorecard(paths, NOW, SINCE));

    expect(lines).toContain("- Cost per merged task: not measured");
    expect(lines).toContain("- Upkeep share: 40%");
  });
});

const HEALTH: FactoryHealth = {
  isoWeek: "2031-W10",
  covered: { upkeepShare: 0.4, reviewRoundsMedian: 1, merged: 13, usd: 88.4 },
  selfGenerated: { agentFiled: 6, agentFiledInferred: 2, unlabelled: 0, closed: 12, mergedPrs: 8, perClosed: 0.5, perMergedPr: 0.75 },
  fenceStops: { dispatched: 15, spawnRefusals: 3, gateHolds: 6, refusalsPer100: 20, holdsPer100: 40, guardDenials: null },
  codeSize: null,
  modelTiers: [
    { model: "large", dispatched: 5, merged: 4, mergeRate: 0.8, fixRoundsMean: 1.5 },
    { model: "small", dispatched: 10, merged: 9, mergeRate: 0.9, fixRoundsMean: 0.5 },
  ],
  wakes: [
    { seat: "orbit-coord", timer: 4, event: 30, typed: 2, timerNoActionShare: null },
    { seat: "kiln-coord", timer: 1, event: 10, typed: 0, timerNoActionShare: null },
  ],
};

describe("the factory health group in the digest", () => {
  it("digest weekly slot prints the factory health group as one line", () => {
    freeze("2031-W10", metrics({}), [], CLOSED_AT, { factoryHealth: HEALTH });

    const lines = scorecardLines(readScorecard(paths, NOW, SINCE));

    expect(lines.filter((line) => line.startsWith("Factory health"))).toEqual([
      "Factory health: agent-filed per closed task 0.5, per merged PR 0.75 (inferred labels); per 100 dispatched 20 refused, 40 held, guard denials not measured; code size not measured; merge rate by model large 80%, small 90%; seat wakes 5 timer, 40 event, no-action share not measured.",
    ]);
  });

  it("a week frozen before the group shows factory health as not measured", () => {
    freeze("2031-W10", metrics({}), []);

    const lines = scorecardLines(readScorecard(paths, NOW, SINCE));

    expect(lines.at(-1)).toBe("Factory health: not measured (week frozen before the group existed).");
  });
});

describe("the scorecard paths", () => {
  it("put the frozen weeks beside the store TITAN_SCORECARD_STORE names", () => {
    expect(scorecardPaths({ TITAN_SCORECARD_STORE: "~/sc/store.sqlite3" }, "/home/user")).toEqual({ storeFile: "/home/user/sc/store.sqlite3", weeksDir: "/home/user/sc/weeks" });
  });
});
