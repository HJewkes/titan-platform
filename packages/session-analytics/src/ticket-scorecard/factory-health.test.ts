import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { factoryHealthWeeks, filerOf, type FactoryHealthInput, type FiledTask } from "./factory-health.js";
import { readFactoryHealth, upsertFactoryHealth } from "./factory-health-store.js";
import { SCORECARD_MIGRATIONS } from "./store.js";
import { taskRow } from "./task-row.js";
import type { TaskRow } from "./types.js";

const WEEK = "2026-W45";
const IN_WEEK = "2026-11-03T10:00:00.000Z";
const NEXT_WEEK = "2026-11-10T10:00:00.000Z";
const INFERRED = "inferred:census";

function row(taskId: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const built = taskRow({
    task: { initiative: "alpha", taskId, createdAt: "2026-11-01T10:00:00.000Z", doneAt: null, estimate: 1 },
    spawns: [{ ts: IN_WEEK, actor: "seat-one", launchedBy: null, dispatchRule: null }],
    registrations: [],
    runs: [],
    gates: [],
    prs: [],
    labels: {},
  });
  return { ...built!, ...overrides };
}

function input(overrides: Partial<FactoryHealthInput> = {}): FactoryHealthInput {
  return { rows: [row("AA-1")], dispatchModels: new Map(), filed: [], mergedPrAts: [], spawnRefusalAts: [], gateHoldAts: [], wakes: [], ...overrides };
}

function only(overrides: Partial<FactoryHealthInput> = {}) {
  const weeks = factoryHealthWeeks(input(overrides));
  expect(weeks.map((w) => w.isoWeek)).toEqual([WEEK]);
  return weeks[0]!;
}

const filed = (createdAt: string, doneAt: string | null, filer: FiledTask["filer"]): FiledTask => ({ createdAt, doneAt, filer });

describe("factory health", () => {
  it("agent-filed tasks are divided by tasks closed and by merged PRs in the week, inferred filings marked", () => {
    const tasks = [
      filed(IN_WEEK, null, { value: "agent", origin: "recorded" }),
      filed(IN_WEEK, null, { value: "agent", origin: INFERRED }),
      filed(IN_WEEK, IN_WEEK, { value: "owner", origin: "recorded" }),
      filed(IN_WEEK, null, null),
      filed(NEXT_WEEK, null, { value: "agent", origin: "recorded" }),
      filed("2026-10-20T10:00:00.000Z", IN_WEEK, { value: "agent", origin: "recorded" }),
      filed("2026-10-20T10:00:00.000Z", IN_WEEK, null),
      filed("2026-10-20T10:00:00.000Z", IN_WEEK, null),
    ];

    const week = only({ filed: tasks, mergedPrAts: [IN_WEEK, IN_WEEK, IN_WEEK, IN_WEEK, NEXT_WEEK] });

    expect(week.selfGenerated).toEqual({ agentFiled: 2, agentFiledInferred: 1, unlabelled: 1, closed: 4, mergedPrs: 4, perClosed: 0.5, perMergedPr: 0.5 });
  });

  it("the recorded source decides the filer before filed_by and the inferred label", () => {
    const inferred = { value: "owner", origin: INFERRED } as const;

    expect(filerOf({ source: "review", filedBy: "owner" }, inferred)).toEqual({ value: "agent", origin: "recorded" });
    expect(filerOf({ source: null, filedBy: "seat-one" }, inferred)).toEqual({ value: "agent", origin: "recorded" });
    expect(filerOf({ source: null, filedBy: null }, inferred)).toEqual({ value: "owner", origin: INFERRED });
    expect(filerOf({ source: null, filedBy: null }, undefined)).toBeNull();
  });

  it("spawn refusals and gate holds are counted per 100 dispatched tasks", () => {
    const rows = [row("AA-1"), row("AA-2"), row("AA-3"), row("AA-4")];

    const week = only({ rows, spawnRefusalAts: [IN_WEEK, IN_WEEK, IN_WEEK, NEXT_WEEK], gateHoldAts: [IN_WEEK, NEXT_WEEK] });

    expect(week.fenceStops).toEqual({ dispatched: 4, spawnRefusals: 3, gateHolds: 1, refusalsPer100: 75, holdsPer100: 25, guardDenials: null });
  });

  it("each dispatch model gets its merge rate and mean fix rounds over tasks with a PR", () => {
    const rows = [
      row("AA-1", { mergedAt: IN_WEEK, prs: 1, fixRounds: 1 }),
      row("AA-2", { prs: 1, fixRounds: 4 }),
      row("AA-3", { mergedAt: IN_WEEK, prs: 1, fixRounds: 0 }),
      row("AA-4"),
    ];
    const models = new Map([["alpha/AA-1", "opus"], ["alpha/AA-2", "opus"], ["alpha/AA-3", "sonnet"], ["alpha/AA-4", null]]);

    const week = only({ rows, dispatchModels: models });

    expect(week.modelTiers).toEqual([
      { model: "opus", dispatched: 2, merged: 1, mergeRate: 0.5, fixRoundsMean: 2.5 },
      { model: "sonnet", dispatched: 1, merged: 1, mergeRate: 1, fixRoundsMean: 0 },
      { model: "unrecorded", dispatched: 1, merged: 0, mergeRate: 0, fixRoundsMean: null },
    ]);
  });

  it("each seat's timer, event and typed wakes are summed for the week, other causes left out", () => {
    const wakes = [
      { seat: "seat-one", day: "2026-11-03", cause: "scheduled_wakeup", turns: 4 },
      { seat: "seat-one", day: "2026-11-08", cause: "channel_message", turns: 3 },
      { seat: "seat-one", day: "2026-11-04", cause: "task_notification", turns: 2 },
      { seat: "seat-one", day: "2026-11-04", cause: "human_typed", turns: 5 },
      { seat: "seat-one", day: "2026-11-04", cause: "compaction", turns: 9 },
      { seat: "seat-one", day: "2026-11-09", cause: "scheduled_wakeup", turns: 7 },
      { seat: "seat-two", day: "2026-11-05", cause: "channel_system", turns: 1 },
    ];

    const week = only({ wakes });

    expect(week.wakes).toEqual([
      { seat: "seat-one", timer: 4, event: 5, typed: 5, timerNoActionShare: null },
      { seat: "seat-two", timer: 0, event: 1, typed: 0, timerNoActionShare: null },
    ]);
  });

  it("figures with no source show as not measured, never zero", () => {
    const week = only({ wakes: null, filed: [filed(IN_WEEK, null, { value: "agent", origin: "recorded" })] });

    expect(week.selfGenerated.perClosed).toBeNull();
    expect(week.selfGenerated.perMergedPr).toBeNull();
    expect(week.fenceStops.guardDenials).toBeNull();
    expect(week.codeSize).toBeNull();
    expect(week.wakes).toBeNull();
  });

  it("a rerun over the same weeks writes nothing and reads back what it wrote", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, SCORECARD_MIGRATIONS);
    const weeks = factoryHealthWeeks(input({ spawnRefusalAts: [IN_WEEK] }));

    const first = upsertFactoryHealth(db, weeks, IN_WEEK);
    const second = upsertFactoryHealth(db, weeks, NEXT_WEEK);

    expect([first, second]).toEqual([1, 0]);
    expect(readFactoryHealth(db)).toEqual(weeks);
    db.close();
  });
});
