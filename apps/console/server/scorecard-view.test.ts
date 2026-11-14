import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  SCORECARD_MIGRATIONS,
  factoryHealthWeeks,
  taskRow,
  upsertFactoryHealth,
  upsertTaskRows,
  upsertWeekRows,
  weekRows,
  type TaskRow,
  type TaskRowInput,
} from "@titan-design/session-analytics";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { readScorecardTask, readScorecardTasks, readScorecardWeeks } from "./scorecard-view.js";

let dir: string;
let storeFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "console-scorecard-"));
  storeFile = path.join(dir, "scorecard.sqlite3");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const INFERRED = "inferred:census-2031-03-01" as const;

function row(taskId: string, dispatchedAt: string, inferred: boolean, mergedAt: string | null = null): TaskRow {
  const origin = inferred ? INFERRED : "recorded";
  const input: TaskRowInput = {
    task: { initiative: "orbit-relay", taskId, createdAt: "2031-02-20T00:00:00.000Z", doneAt: null, estimate: 1 },
    spawns: [{ ts: dispatchedAt, actor: "orbit-coord", launchedBy: null, dispatchRule: null }],
    registrations: mergedAt === null ? [] : [{ repo: "orbit/relay", pr: 7 }],
    runs: [],
    gates: [],
    prs: mergedAt === null ? [] : [{ repo: "orbit/relay", pr: 7, mergedAt, closedAt: mergedAt }],
    labels: { class: { value: "upkeep", origin }, source: { value: "sweep", origin } },
  };
  const built = taskRow(input);
  if (built === null) throw new Error("expected a dispatched task");
  return built;
}

/** Writes the store as the ticket-scorecard job would: task rows, then the weekly cells over them. */
function seed(rows: readonly TaskRow[]): void {
  const db = openDatabase(storeFile);
  runMigrations(db, SCORECARD_MIGRATIONS);
  upsertTaskRows(db, rows, "2031-03-06T00:00:00.000Z");
  upsertWeekRows(db, weekRows(rows, DEFAULT_THRESHOLDS), "2031-03-06T00:00:00.000Z");
  db.close();
}

const W09 = "2031-02-27T10:00:00.000Z";
const W10 = "2031-03-05T10:00:00.000Z";

describe("the scorecard view's reads", () => {
  it("answers missing, not an empty scorecard, when the host has no store", () => {
    expect(readScorecardWeeks({ storeFile }).store.state).toBe("missing");
    expect(readScorecardTasks({ storeFile }, {})).toMatchObject({ store: { state: "missing" }, total: 0, rows: [] });
  });

  it("returns the stored cells newest week first, with the frozen and drifted weeks named by their files", () => {
    seed([row("OR-1", W09, false), row("OR-2", W10, true)]);
    mkdirSync(path.join(dir, "weeks"));
    writeFileSync(path.join(dir, "weeks", "2031-W09.json"), "{}");
    writeFileSync(path.join(dir, "weeks", "2031-W09.drift.json"), "{}");

    const { weeks } = readScorecardWeeks({ storeFile });

    expect(weeks.map((w) => [w.isoWeek, w.frozen, w.drift])).toEqual([
      ["2031-W10", false, false],
      ["2031-W09", true, true],
    ]);
    const all = weeks[0]!.cells.find((cell) => cell.dimension === "all")!;
    expect(all.redFlags).toContain("upkeep-cap");
    expect(all.metrics.costPerMerged).toBeNull();
  });

  it("attaches each week's factory health group, and none to a week the job scored without it", () => {
    const rows = [row("OR-1", W09, false), row("OR-2", W10, true)];
    seed(rows);
    const db = openDatabase(storeFile);
    const health = factoryHealthWeeks({ rows: [rows[1]!], dispatchModels: new Map(), filed: [], mergedPrAts: [], spawnRefusalAts: [W10], gateHoldAts: [], wakes: null });
    upsertFactoryHealth(db, health, "2031-03-06T00:00:00.000Z");
    db.close();

    const { weeks } = readScorecardWeeks({ storeFile });

    expect(weeks.map((w) => [w.isoWeek, w.factoryHealth?.fenceStops.spawnRefusals ?? null])).toEqual([
      ["2031-W10", 1],
      ["2031-W09", null],
    ]);
  });

  it("reads a store written before the factory health table as weeks without the group", () => {
    const db = openDatabase(storeFile);
    runMigrations(db, SCORECARD_MIGRATIONS.slice(0, 2));
    upsertWeekRows(db, weekRows([row("OR-1", W10, false)], DEFAULT_THRESHOLDS), "2031-03-06T00:00:00.000Z");
    db.close();

    const read = readScorecardWeeks({ storeFile });

    expect(read.store.state).toBe("ok");
    expect(read.weeks.map((w) => w.factoryHealth)).toEqual([null]);
  });

  it("lists only open tasks resting on an inferred label for review", () => {
    seed([row("OR-1", W10, false), row("OR-2", W10, true), row("OR-3", W10, true, "2031-03-05T12:00:00.000Z")]);

    const review = readScorecardTasks({ storeFile }, { inferred: true });

    expect(review.rows.map((r) => r.taskId)).toEqual(["OR-2"]);
    expect(review.rows[0]!.provenance["classAtDispatch"]).toBe(INFERRED);
  });

  it("keeps one ISO week's tasks and drops the others", () => {
    seed([row("OR-1", W09, false), row("OR-2", W10, false)]);

    expect(readScorecardTasks({ storeFile }, { week: "2031-W09" }).rows.map((r) => r.taskId)).toEqual(["OR-1"]);
  });

  it("reads one task's row, and null for a task that was never dispatched", () => {
    seed([row("OR-2", W10, true)]);

    expect(readScorecardTask({ storeFile }, "orbit-relay", "OR-2").row?.classAtDispatch).toBe("upkeep");
    expect(readScorecardTask({ storeFile }, "orbit-relay", "OR-9").row).toBeNull();
  });
});
