import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, type FixtureGraph } from "./fixture.js";
import { taskActuals, type ActualsTask } from "./task-actuals.js";
import type { ShepherdRunRecord } from "./task-actuals-shepherd.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
});
afterEach(() => fixture.close());

const INITIATIVE = "alpha";
const OPTIONS = { initiatives: [INITIATIVE] };
const IMPL_START = "2026-10-05T09:00:00Z";

function task(id: string): ActualsTask {
  return { id, initiative: INITIATIVE, doneAt: "2026-10-06T12:00:00Z" };
}

function addImplSession(id: string, taskId: string): void {
  const db = fixture.graph.db;
  insertOrigin(db, { sessionId: id, depth: 1, profile: "implementer" });
  db.prepare("UPDATE session_origin SET task_ids = ?, task_source = 'name' WHERE session_id = ?").run(JSON.stringify([taskId]), id);
  insertRequest(db, { sessionId: id, ts: IMPL_START, outputTokens: 1000, model: "claude-opus-5", gapMs: null });
}

function linkPr(sessionId: string, prRef: string, mergedAt: string | null): void {
  fixture.graph.db.prepare("INSERT OR IGNORE INTO pr (pr_ref, merged_at) VALUES (?, ?)").run(prRef, mergedAt);
  fixture.graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "linked", targetRef: prRef });
}

function run(overrides: Partial<ShepherdRunRecord>): ShepherdRunRecord {
  return {
    runId: "run-1",
    task: null,
    repo: "acme/widget",
    pr: null,
    kind: "feature",
    status: "done",
    startedAt: "2026-10-05T10:00:00Z",
    completedAt: "2026-10-05T12:00:00Z",
    stageMinutes: {},
    reviewRounds: 1,
    mergedAt: null,
    mergePath: null,
    ...overrides,
  };
}

describe("taskActuals with Shepherd runs", () => {
  it("leaves rows without Shepherd keys when no runs are passed", () => {
    addImplSession("s1", "T-1");

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

    expect(row).not.toHaveProperty("reviewRounds");
    expect(row).not.toHaveProperty("mergePath");
  });

  it("joins a run by its task id and measures service hours to its merge", () => {
    addImplSession("s1", "T-1");
    const runs = [run({ task: "alpha/T-1", stageMinutes: { ci: 12.5, review: 30 }, mergedAt: "2026-10-05T13:00:00Z", mergePath: "shepherd" })];

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], { ...OPTIONS, shepherdRuns: runs });

    expect(row).toMatchObject({ reviewRounds: 1, stageMinutes: { ci: 12.5, review: 30 }, mergePath: "shepherd" });
    expect(row!.serviceWallHours).toBeCloseTo(4);
  });

  it("joins a run by its PR ref case-insensitively", () => {
    addImplSession("s1", "T-1");
    linkPr("s1", "Acme/Widget#7", "2026-10-05T13:00:00Z");
    const runs = [run({ pr: 7, mergedAt: "2026-10-05T13:00:00Z", mergePath: "shepherd" })];

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], { ...OPTIONS, shepherdRuns: runs });

    expect(row!.mergePath).toBe("shepherd");
    expect(row!.reviewRounds).toBe(1);
  });

  it("sums review rounds and stage minutes over every joined run", () => {
    addImplSession("s1", "T-1");
    const runs = [
      run({ runId: "run-1", task: "alpha/T-1", reviewRounds: 2, stageMinutes: { review: 10.25 }, status: "cancelled" }),
      run({ runId: "run-2", task: "alpha/T-1", reviewRounds: 1, stageMinutes: { review: 5.5, land: 2 }, mergedAt: "2026-10-05T14:00:00Z", mergePath: "shepherd" }),
    ];

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], { ...OPTIONS, shepherdRuns: runs });

    expect(row!.reviewRounds).toBe(3);
    expect(row!.stageMinutes).toEqual({ review: 15.75, land: 2 });
  });

  it("marks a merged PR with no Shepherd run as merged outside", () => {
    addImplSession("s1", "T-1");
    linkPr("s1", "acme/widget#8", "2026-10-05T11:00:00Z");
    const runs = [run({ task: "alpha/T-other", pr: 99 })];

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], { ...OPTIONS, shepherdRuns: runs });

    expect(row).toMatchObject({ mergePath: "outside", reviewRounds: null, stageMinutes: null });
    expect(row!.serviceWallHours).toBeCloseTo(2);
  });

  it("gives null Shepherd facts to a row merged before the ledger began", () => {
    addImplSession("s1", "T-1");
    linkPr("s1", "acme/widget#8", "2026-10-05T11:00:00Z");
    const runs = [run({ task: "alpha/T-other" })];

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], { ...OPTIONS, shepherdRuns: runs, shepherdSince: "2026-10-05T12:00:00Z" });

    expect(row).toMatchObject({ mergePath: null, reviewRounds: null, stageMinutes: null });
    expect(row!.serviceWallHours).toBeCloseTo(2);
  });
});
