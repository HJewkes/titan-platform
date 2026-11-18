import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readPoolSnapshot, readTaskRows, readWeekRows, type TaskRow } from "@titan-design/session-analytics";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTicketScorecard, type ScorecardRunOptions, type ScorecardRunResult } from "./run.js";
import { ScorecardWorld } from "./run.fixture.js";

// ISO 2026-W46 runs Monday 11-09 to Sunday 11-15; W47 starts Monday 11-16.
const W46_MON = "2026-11-09T08:00:00.000Z";
const W46_WED = "2026-11-11T12:00:00.000Z";
const W46_THU = "2026-11-12T12:00:00.000Z";
const W47_MON = "2026-11-16T08:00:00.000Z";
const W47_TUE = "2026-11-17T08:00:00.000Z";

async function run(options: ScorecardRunOptions): Promise<ScorecardRunResult> {
  const result = await runTicketScorecard(options);
  if ("locked" in result) throw new Error("expected the lock to be free");
  return result;
}

function storeRows(world: ScorecardWorld): Map<string, TaskRow & { computedAt: string }> {
  const db = openDatabase(world.file("scorecard.sqlite3"), { readonly: true });
  try {
    const computed = new Map(db.prepare<[], { task_id: string; computed_at: string }>("SELECT task_id, computed_at FROM task_row").all().map((r) => [r.task_id, r.computed_at]));
    return new Map(readTaskRows(db).map((r) => [r.taskId, { ...r, computedAt: computed.get(r.taskId)! }]));
  } finally {
    db.close();
  }
}

let world: ScorecardWorld;

beforeEach(() => {
  world = new ScorecardWorld();
  world.task("AA-1", { priority: 2 });
  world.task("AA-2", { priority: 1, status: "done" });
  world.spawn("AA-1", "2026-11-10T09:00:00.000Z");
  world.spawn("AA-2", "2026-11-10T10:00:00.000Z", "seat-two");
  world.register("AA-1", 11, "run-a", { status: "running", startedAt: "2026-11-10T12:00:00.000Z" });
  world.register("AA-2", 12, "run-b", { status: "completed", startedAt: "2026-11-10T12:00:00.000Z", completedAt: "2026-11-10T16:00:00.000Z" });
  world.pr(12, { mergedAt: "2026-11-10T15:00:00.000Z", checkedAt: "2026-11-10T15:30:00.000Z" });
  const heuristics = { class: "census-test:theme", source: "census-test:source" };
  world.labels([
    { task: "alpha/AA-1", class: "product", source: "owner", serves: null, heuristics },
    { task: "alpha/AA-2", class: "mixed", source: "follow-up", serves: null, heuristics },
  ]);
});

afterEach(() => world.close());

describe("ticket-scorecard run", () => {
  it("run twice writes nothing the second time", async () => {
    const first = await run(world.options(W46_WED));
    const before = world.dumpStore();

    const second = await run(world.options(W46_THU));

    expect(first).toMatchObject({ taskRowsChanged: 2, labels: { rows: 2, invalid: 0 } });
    expect(storeRows(world).get("AA-2")).toMatchObject({ classAtDispatch: "upkeep", provenance: { classAtDispatch: "inferred:census-test:theme" } });
    expect(second).toMatchObject({ ok: true, taskRowsChanged: 0, weekRowsChanged: 0, phaseRowsChanged: 0, healthRowsChanged: 0, poolRowsWritten: 0, marksAdvanced: 0, frozen: [], drift: [] });
    expect(world.dumpStore()).toBe(before);
  });

  it("a new await-new-head step re-computes only that task", async () => {
    await run(world.options(W46_WED));
    world.addStep("run-a", "sh-await-new-head:0", "2026-11-11T13:00:00.000Z");

    const second = await run(world.options(W46_THU));

    const rows = storeRows(world);
    expect(second.taskRowsChanged).toBe(1);
    expect(rows.get("AA-1")).toMatchObject({ fixRounds: 1, computedAt: W46_THU });
    expect(rows.get("AA-2")?.computedAt).toBe(W46_WED);
  });

  it("a successor inside an await-new-head round is counted once", async () => {
    world.addStep("run-a", "sh-await-new-head:0", "2026-11-11T13:00:00.000Z");
    world.successor("run-a", "2026-11-11T12:30:00.000Z");
    world.successor("run-a", "2026-11-11T14:00:00.000Z");

    await run(world.options(W46_WED));

    expect(storeRows(world).get("AA-1")?.fixRounds).toBe(2);
  });

  it("pool snapshot is written once per ISO week", async () => {
    const monday = await run(world.options(W46_MON));
    world.task("AA-3", { priority: 3 });

    const later = await run(world.options(W46_WED));
    const nextWeek = await run(world.options(W47_MON));

    const db = openDatabase(world.file("scorecard.sqlite3"), { readonly: true });
    expect(monday.poolRowsWritten).toBe(1);
    expect(later.poolRowsWritten).toBe(0);
    expect(readPoolSnapshot(db, "2026-W46").map((t) => t.taskId)).toEqual(["AA-1"]);
    expect(nextWeek.poolRowsWritten).toBe(2);
    expect(readPoolSnapshot(db, "2026-W47").map((t) => t.taskId)).toEqual(["AA-1", "AA-3"]);
    db.close();
  });

  it("closed week drift is reported not overwritten", async () => {
    const first = await run(world.options(W47_MON));
    const frozenFile = path.join(world.file("weeks"), "2026-W46.json");
    const frozen = readFileSync(frozenFile, "utf8");
    world.pr(11, { mergedAt: "2026-11-16T10:00:00.000Z", checkedAt: "2026-11-16T10:30:00.000Z" });

    const second = await run(world.options(W47_TUE));

    expect(first.frozen).toEqual(["2026-W46"]);
    expect(second.drift).toEqual(["2026-W46"]);
    expect(readFileSync(frozenFile, "utf8")).toBe(frozen);
    const drift = JSON.parse(readFileSync(path.join(world.file("weeks"), "2026-W46.drift.json"), "utf8"));
    expect(drift.cells.find((c: { dimension: string }) => c.dimension === "all").metrics.merged).toBe(2);
  });

  it("the frozen week file carries the factory health group read from the stores", async () => {
    world.task("AA-3");
    world.spawn("AA-3", "2026-11-10T11:00:00.000Z", "seat-one", undefined, undefined, "sonnet");
    world.refusal("2026-11-10T11:30:00.000Z");
    world.gate("run-a/approve-merge", "2026-11-10T13:00:00.000Z");

    await run(world.options(W47_MON));

    const health = JSON.parse(readFileSync(path.join(world.file("weeks"), "2026-W46.json"), "utf8")).factoryHealth;
    expect(health.fenceStops).toEqual({ dispatched: 3, spawnRefusals: 1, gateHolds: 1, refusalsPer100: 33.33, holdsPer100: 33.33, guardDenials: null });
    expect(health.modelTiers.map((t: { model: string; dispatched: number }) => [t.model, t.dispatched])).toEqual([["sonnet", 1], ["unrecorded", 2]]);
    expect(health.selfGenerated).toMatchObject({ mergedPrs: 1, closed: 1 });
    expect(health.codeSize).toBeNull();
  });

  it("a week frozen before the factory health group existed does not read as drift", async () => {
    await run(world.options(W47_MON));
    const frozenFile = path.join(world.file("weeks"), "2026-W46.json");
    const legacy = JSON.parse(readFileSync(frozenFile, "utf8"));
    delete legacy.factoryHealth;
    writeFileSync(frozenFile, `${JSON.stringify(legacy, null, 2)}\n`);

    const second = await run(world.options(W47_TUE));

    expect(second.drift).toEqual([]);
    expect(JSON.parse(readFileSync(frozenFile, "utf8"))).toEqual(legacy);
  });

  it("missing store reads as not measured", async () => {
    rmSync(world.file("labels.jsonl"));
    rmSync(world.file("graph.sqlite3"));

    const withoutGraph = await run(world.options(W46_WED));

    expect(withoutGraph).toMatchObject({ ok: false, exitCode: 69, notMeasured: ["graph", "labels"], taskRowsChanged: 0, marksAdvanced: 0 });
    expect(storeRows(world).size).toBe(0);
  });

  it("a missing labels file leaves class and its share unmeasured, not zero", async () => {
    rmSync(world.file("labels.jsonl"));

    const result = await run(world.options(W46_WED));

    const db = openDatabase(world.file("scorecard.sqlite3"), { readonly: true });
    const all = readWeekRows(db).find((r) => r.dimension === "all")!;
    db.close();
    expect(result).toMatchObject({ ok: true, notMeasured: ["labels"] });
    expect(storeRows(world).get("AA-1")?.classAtDispatch).toBeNull();
    expect(all.metrics.productShare).toBeNull();
  });
});
