import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, redFlags } from "./red-flags.js";
import { rulePick, rulePlacement, type PoolTask } from "./rule-pick.js";
import { SCORECARD_MIGRATIONS, readPoolSnapshot, readTaskRows, readWeekRows, upsertTaskRows, upsertWeekRows, writePoolSnapshot } from "./store.js";
import { taskRow } from "./task-row.js";
import type { TaskRow, TaskRowInput } from "./types.js";
import { weekMetrics } from "./week-metrics.js";
import { weekRows } from "./week-rows.js";

const REPO = "acme/widgets";
const DISPATCHED = "2026-11-02T10:00:00.000Z";

function input(overrides: Partial<TaskRowInput> = {}, taskId = "AA-1"): TaskRowInput {
  return {
    task: { initiative: "alpha", taskId, createdAt: "2026-11-01T10:00:00.000Z", doneAt: null, estimate: 2 },
    spawns: [{ ts: DISPATCHED, actor: "seat-one", launchedBy: null, dispatchRule: null }],
    registrations: [],
    runs: [],
    gates: [],
    prs: [],
    labels: {},
    ...overrides,
  };
}

function row(overrides: Partial<TaskRowInput> = {}, taskId = "AA-1"): TaskRow {
  const built = taskRow(input(overrides, taskId));
  if (built === null) throw new Error("expected a dispatched task");
  return built;
}

describe("task rows", () => {
  it("task row counts fix rounds from await-new-head steps and lineage", () => {
    const runs = [
      { runId: "r1", stepIds: ["sh-await-pr", "sh-await-new-head", "sh-main-ci", "sh-await-new-head"], reviewRounds: 3, successors: 0 },
      { runId: "r2", stepIds: ["await-new-head", "sh-land"], reviewRounds: 1, successors: 1 },
    ];

    const built = row({ runs });

    expect(built.fixRounds).toBe(4);
    expect(built.reviewRounds).toBe(4);
  });

  it("fix rounds count suffixed await-new-head step ids", () => {
    const runs = [
      { runId: "r1", stepIds: ["sh-await-pr:0", "sh-await-new-head:1", "sh-main-ci:2", "sh-await-new-head:3"], reviewRounds: 0, successors: 0 },
      { runId: "r2", stepIds: ["await-new-head:0", "await-new-head-later:1", "sh-land:2"], reviewRounds: 0, successors: 0 },
    ];

    const built = row({ runs });

    expect(built.fixRounds).toBe(3);
  });

  it("task row marks merged only through a registration for the task", () => {
    const prs = [
      { repo: REPO, pr: 10, mergedAt: "2026-11-02T12:00:00.000Z", closedAt: "2026-11-02T12:00:00.000Z" },
      { repo: REPO, pr: 11, mergedAt: "2026-11-03T16:00:00.000Z", closedAt: "2026-11-03T16:00:00.000Z" },
    ];

    const unregistered = row({ prs });
    const registered = row({ prs, registrations: [{ repo: "Acme/Widgets", pr: 11 }] });

    expect(unregistered.mergedAt).toBeNull();
    expect(unregistered.prs).toBe(0);
    expect(registered.mergedAt).toBe("2026-11-03T16:00:00.000Z");
    expect(registered.leadDispatchMergeH).toBe(30);
  });

  it("a task that only Shepherd spawned is outside the population", () => {
    const spawns = [{ ts: DISPATCHED, actor: "titan-factory", launchedBy: "shepherd", dispatchRule: null }];

    expect(taskRow(input({ spawns }))).toBeNull();
  });

  it("an inferred input marks the row's provenance inferred", () => {
    const recorded = row({ labels: { class: { value: "product", origin: "recorded" } } });
    const inferred = row({ labels: { class: { value: "mixed", origin: "inferred:census-2026-11-12" }, source: { value: "owner", origin: "recorded" } } });

    expect(recorded.provenance).toEqual({ classAtDispatch: "recorded" });
    expect(inferred.classAtDispatch).toBe("upkeep");
    expect(inferred.provenance).toEqual({ classAtDispatch: "inferred:census-2026-11-12", sourceAtDispatch: "recorded" });
    expect(weekMetrics([recorded, inferred]).inferredShare).toBe(0.5);
  });

  it("the inputs hash does not depend on the order the reader listed the inputs", () => {
    const gates = [
      { createdAt: "2026-11-02T11:00:00.000Z", resolvedAt: "2026-11-02T13:00:00.000Z", resolvedByClass: "owner-terminal" },
      { createdAt: "2026-11-02T14:00:00.000Z", resolvedAt: "2026-11-02T15:00:00.000Z", resolvedByClass: "coordinator" },
    ];

    const forward = row({ gates });
    const reversed = row({ gates: [...gates].reverse() });

    expect(forward.inputsHash).toBe(reversed.inputsHash);
    expect(forward.ownerGates).toBe(1);
    expect(forward.ownerGateHours).toBe(2);
  });
});

describe("rule pick", () => {
  const pool: PoolTask[] = [
    { taskId: "AA-5", class: "upkeep", rank: 1, createdAt: "2026-09-01T00:00:00.000Z" },
    { taskId: "AA-4", class: "product", rank: 3, createdAt: "2026-09-01T00:00:00.000Z" },
    { taskId: "AA-3", class: "product", rank: 2, createdAt: "2026-10-20T00:00:00.000Z" },
    { taskId: "AA-2", class: "product", rank: 2, createdAt: "2026-10-01T00:00:00.000Z" },
    { taskId: "AA-1", class: null, rank: 0, createdAt: "2026-08-01T00:00:00.000Z" },
  ];

  it("rule pick orders product then rank then age and takes K", () => {
    const pick = rulePick(pool, 3);

    expect(pick.ranked).toEqual(["AA-2", "AA-3", "AA-4", "AA-5", "AA-1"]);
    expect(pick.topK).toEqual(["AA-2", "AA-3", "AA-4"]);
    expect(rulePick([...pool].reverse(), 3)).toEqual(pick);
  });

  it("rule placement gives the share of the pool ranked ahead and whether the task made the top K", () => {
    const pick = rulePick(pool, 2);

    expect(rulePlacement(pick, "AA-4")).toEqual({ rankPct: 0.4, inTopK: false });
    expect(rulePlacement(pick, "AA-3")).toEqual({ rankPct: 0.2, inTopK: true });
    expect(rulePlacement(pick, "AA-9")).toBeNull();
  });
});

describe("red flags", () => {
  const classed = (product: number, upkeep: number): TaskRow[] => [
    ...Array.from({ length: product }, (_, i) => row({ labels: { class: { value: "product", origin: "recorded" } } }, `P-${i}`)),
    ...Array.from({ length: upkeep }, (_, i) => row({ labels: { class: { value: "upkeep", origin: "recorded" } } }, `U-${i}`)),
  ];

  it("red flags fire at the threshold, not below", () => {
    // The plan's table reads "above 25%": crossing the bound fires, sitting on it does not.
    const thresholds = { ...DEFAULT_THRESHOLDS, ownerSourcedShareMin: 0, ruleAgreementMin: 0 };

    expect(redFlags(weekMetrics(classed(2, 1)), thresholds)).toEqual(["upkeep-cap"]);
    expect(redFlags(weekMetrics(classed(3, 1)), thresholds)).toEqual([]);
    expect(redFlags(weekMetrics(classed(4, 1)), thresholds)).toEqual([]);
  });

  it("a floor flag fires below its bound and an unmeasured figure fires nothing", () => {
    const owner = (taskId: string, source: string): TaskRow => row({ labels: { source: { value: source, origin: "recorded" } } }, taskId);
    const tenth = [owner("S-0", "owner"), ...Array.from({ length: 9 }, (_, i) => owner(`S-${i + 1}`, "plan"))];
    const under = [...tenth, owner("S-10", "plan")];

    expect(redFlags(weekMetrics(tenth), DEFAULT_THRESHOLDS)).toEqual([]);
    expect(redFlags(weekMetrics(under), DEFAULT_THRESHOLDS)).toEqual(["owner-floor"]);
  });
});

describe("scorecard store", () => {
  let incremental: Db;
  let rebuilt: Db;

  beforeEach(() => {
    incremental = openDatabase(":memory:");
    rebuilt = openDatabase(":memory:");
    runMigrations(incremental, SCORECARD_MIGRATIONS);
    runMigrations(rebuilt, SCORECARD_MIGRATIONS);
  });

  afterEach(() => {
    incremental.close();
    rebuilt.close();
  });

  const merged = { registrations: [{ repo: REPO, pr: 7 }], prs: [{ repo: REPO, pr: 7, mergedAt: "2026-11-04T10:00:00.000Z", closedAt: "2026-11-04T10:00:00.000Z" }] };
  const labels = { class: { value: "product", origin: "inferred:census-2026-11-12" }, source: { value: "owner", origin: "recorded" } } as const;
  const first = [
    row({ labels, actuals: { usd: 4.5, link: "recorded" } }, "AA-1"),
    row({ spawns: [{ ts: "2026-11-10T09:00:00.000Z", actor: "seat-two", launchedBy: null, dispatchRule: null }] }, "AA-2"),
  ];
  const revised = row({ labels, ...merged, actuals: { usd: 6.25, link: "recorded" } }, "AA-1");

  it("week rows are identical after incremental and rebuild", () => {
    upsertTaskRows(incremental, first, "2026-11-11T00:00:00.000Z");
    upsertWeekRows(incremental, weekRows(readTaskRows(incremental), DEFAULT_THRESHOLDS), "2026-11-11T00:00:00.000Z");
    upsertTaskRows(incremental, [revised], "2026-11-12T00:00:00.000Z");
    upsertWeekRows(incremental, weekRows(readTaskRows(incremental), DEFAULT_THRESHOLDS), "2026-11-12T00:00:00.000Z");

    upsertTaskRows(rebuilt, [first[1]!, revised], "2026-11-13T00:00:00.000Z");
    upsertWeekRows(rebuilt, weekRows(readTaskRows(rebuilt), DEFAULT_THRESHOLDS), "2026-11-13T00:00:00.000Z");

    const weeks = readWeekRows(incremental);
    expect(weeks).toEqual(readWeekRows(rebuilt));
    expect(weeks.map((w) => `${w.isoWeek} ${w.dimension} ${w.key}`)).toContain("2026-W45 dispatcher seat-one");
    expect(weeks.find((w) => w.isoWeek === "2026-W45" && w.dimension === "all")?.metrics.costPerMerged).toBe(6.25);
    expect(readTaskRows(incremental)).toEqual(readTaskRows(rebuilt));
  });

  it("an unchanged task row is not rewritten", () => {
    upsertTaskRows(incremental, first, "2026-11-11T00:00:00.000Z");

    expect(upsertTaskRows(incremental, first, "2026-11-12T00:00:00.000Z")).toBe(0);
    expect(upsertTaskRows(incremental, [revised], "2026-11-12T00:00:00.000Z")).toBe(1);
  });

  it("the pool snapshot of a week is written once", () => {
    const pool: PoolTask[] = [{ taskId: "AA-1", class: "product", rank: 1, createdAt: "2026-10-01T00:00:00.000Z" }];

    expect(writePoolSnapshot(incremental, "2026-W45", pool)).toBe(1);
    expect(writePoolSnapshot(incremental, "2026-W45", [...pool, { ...pool[0]!, taskId: "AA-2" }])).toBe(0);
    expect(readPoolSnapshot(incremental, "2026-W45")).toEqual(pool);
  });
});
