import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costPerOutcome, costPerOutcomeSchema, renderCostPerOutcomeText, type Assignment, type CostPerOutcomeReport } from "./cost-per-outcome.js";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, insertSession, type FixtureGraph } from "./fixture.js";
import { priceRequest } from "./price-request.js";
import { LIST_PRICE_CAVEAT } from "./render-text.js";

const WINDOW = { since: "2026-09-20", until: "2026-09-21" } as const;
const TS = "2026-09-20T12:00:00Z";

let fixture: FixtureGraph;
let report: CostPerOutcomeReport;

const costOf = (outputTokens: number) => priceRequest({ outputTokens }, "claude-opus-5", TS).costUsd;
const find = (buckets: CostPerOutcomeReport["bySeat"], key: string) => buckets.find((bucket) => bucket.key === key)!;

function assignment(fields: Partial<Assignment> & Pick<Assignment, "agent">): Assignment {
  return { seat: "seat-a", task: null, kind: null, initiative: "demo", outcome: null, value: null, pr: null, ts: TS, ...fields };
}

const ASSIGNMENTS: Assignment[] = [
  assignment({ agent: "impl-1", task: "DEMO-1", kind: "feature", outcome: "parked", value: "high" }),
  assignment({ agent: "impl-1", task: "DEMO-1", kind: "feature", outcome: "merged", value: "high" }),
  assignment({ agent: "impl-2", task: "DEMO-2", kind: "bug", outcome: "done" }),
  assignment({ agent: "impl-3", task: "DEMO-3", kind: "chore", outcome: "parked" }),
];

function seed(fixture: FixtureGraph): void {
  const db = fixture.graph.db;
  insertPrices(fixture.graph);
  for (const sessionId of ["s-seat", "s-impl-1", "s-task"]) insertSession(db, { sessionId });
  insertOrigin(db, { sessionId: "s-seat", depth: 1, agentName: "seat-a" });
  insertOrigin(db, { sessionId: "s-impl-1", depth: 2, agentName: "impl-1" });
  insertOrigin(db, { sessionId: "s-task", depth: 2 });
  db.prepare("UPDATE session_origin SET task_ids = ?, task_source = 'brief' WHERE session_id = 's-task'").run(JSON.stringify(["DEMO-2"]));
  insertRequest(db, { sessionId: "s-seat", transcriptId: 1, ts: TS, outputTokens: 1_000 });
  insertRequest(db, { sessionId: "s-impl-1", transcriptId: 2, ts: TS, outputTokens: 2_000 });
  insertRequest(db, { sessionId: "s-impl-1", transcriptId: 2, ts: "2026-09-19T23:59:59Z", outputTokens: 900_000 });
  insertRequest(db, { sessionId: "s-impl-1", transcriptId: 2, ts: WINDOW.until, outputTokens: 900_000 });
  insertRequest(db, { sessionId: "s-task", transcriptId: 3, ts: TS, outputTokens: 4_000 });
}

beforeEach(() => {
  fixture = createFixtureGraph();
  seed(fixture);
  report = costPerOutcome(fixture.openReadOnly(), ASSIGNMENTS, WINDOW);
});
afterEach(() => fixture.close());

describe("costPerOutcome", () => {
  it("costs an agent in a first try and a fix round once", () => {
    expect(report.totals.costUsd).toBeCloseTo(costOf(2_000) + costOf(4_000), 10);
    expect(find(report.byKind, "feature").costUsd).toBeCloseTo(costOf(2_000), 10);
    expect(report.totals.assignments).toBe(4);
  });

  it("falls back to task_ids when no session carries the agent's name", () => {
    expect(find(report.byKind, "bug").costUsd).toBeCloseTo(costOf(4_000), 10);
    expect(report.joinSource).toEqual({ agentName: 2, taskId: 1, seat: 0, none: 1 });
  });

  it("lists an agent with neither a name nor a task match as unmatched", () => {
    expect(report.unmatchedAgents).toEqual(["impl-3"]);
    expect(find(report.byKind, "chore")).toMatchObject({ assignments: 1, costUsd: 0 });
  });

  it("reads no request before since or at until", () => {
    const unbounded = costPerOutcome(fixture.openReadOnly(), ASSIGNMENTS, { since: null, until: null });

    expect(find(report.byKind, "feature").costUsd).toBeCloseTo(costOf(2_000), 10);
    expect(find(unbounded.byKind, "feature").costUsd).toBeCloseTo(costOf(2_000) + 2 * costOf(900_000), 10);
  });

  it("divides a group's whole cost, parked tries included, by its merges", () => {
    const feature = find(report.byKind, "feature");
    expect(feature).toMatchObject({ assignments: 2, merged: 1 });
    expect(feature.usdPerMerged).toBeCloseTo(costOf(2_000), 10);
    expect(find(report.byKind, "bug").usdPerMerged).toBeNull();
    expect(find(report.byKind, "bug").usdPerDone).toBeCloseTo(costOf(4_000), 10);
  });

  it("counts window requests per finished agent, null where none finished", () => {
    expect(report.totals).toMatchObject({ requests: 2, requestsPerFinished: 1 });
    expect(find(report.byKind, "feature")).toMatchObject({ requests: 1, requestsPerFinished: 1 });
    expect(find(report.byKind, "chore")).toMatchObject({ requests: 0, requestsPerFinished: null });
  });

  it("splits an agent's requests over its assignments like its cost", () => {
    const split = [
      assignment({ agent: "impl-1", task: "DEMO-1", kind: "first-try", outcome: "parked" }),
      assignment({ agent: "impl-1", task: "DEMO-1", kind: "fix-round", outcome: "merged" }),
    ];
    const unbounded = costPerOutcome(fixture.openReadOnly(), split, { since: null, until: null });

    expect(find(unbounded.byKind, "fix-round")).toMatchObject({ requests: 1.5, requestsPerFinished: 1.5 });
    expect(find(unbounded.byKind, "first-try")).toMatchObject({ requests: 1.5, requestsPerFinished: null });
  });

  it("keeps the seat's own session out of every bucket", () => {
    expect(report.seatCostUsd).toEqual([{ key: "seat-a", costUsd: costOf(1_000) }]);
    expect(find(report.bySeat, "seat-a").costUsd).toBeCloseTo(costOf(2_000) + costOf(4_000), 10);
  });

  it("treats an agent named like a seat as the seat", () => {
    const seatAsAgent = costPerOutcome(fixture.openReadOnly(), [assignment({ agent: "seat-a", outcome: "merged" })], WINDOW);
    expect(seatAsAgent.totals.costUsd).toBe(0);
    expect(seatAsAgent.joinSource.seat).toBe(1);
  });

  it("groups a null key as (none) and matches its schema", () => {
    expect(find(report.byValue, "(none)").assignments).toBe(2);
    expect(costPerOutcomeSchema.parse(report)).toEqual(report);
  });
});

describe("renderCostPerOutcomeText", () => {
  it("carries the list-price caveat and the unmatched agents", () => {
    const text = renderCostPerOutcomeText(report);
    expect(text).toContain(LIST_PRICE_CAVEAT);
    expect(text).toContain("Unmatched agents: impl-3");
    expect(text).toContain("By initiative");
    expect(text).toContain("req/finished");
  });
});
