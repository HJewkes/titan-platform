import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, insertTaskEdge, type FixtureGraph } from "./fixture.js";
import { readTaskInitiative, taskLedger } from "./task-ledger.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
});

afterEach(() => fixture.close());

function seedOriginLinked(id: string, agentName: string, profile: string, ts: string): void {
  const db = fixture.graph.db;
  insertOrigin(db, { sessionId: id, depth: 1, profile, agentName });
  db.prepare("UPDATE session_origin SET task_ids = ? WHERE session_id = ?").run(JSON.stringify(["T-1"]), id);
  insertRequest(db, { sessionId: id, ts, inputTokens: 1_000_000 });
  insertRequest(db, { sessionId: id, ts: ts.replace("T10", "T11"), outputTokens: 1_000_000 });
}

function linkPr(sessionId: string, prRef: string, state: string, mergedAt: string | null): void {
  fixture.graph.db.prepare("INSERT OR IGNORE INTO pr (pr_ref, state, merged_at) VALUES (?, ?, ?)").run(prRef, state, mergedAt);
  fixture.graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "linked", targetRef: prRef });
}

function verdict(sourceKey: string, prRef: string, value: string, ts: string): void {
  fixture.graph.db
    .prepare("INSERT INTO pr_review (source_key, surface, verdict, ts, number, pr_ref) VALUES (?, 'gh', ?, ?, 1, ?)")
    .run(sourceKey, value, ts, prRef);
}

describe("taskLedger", () => {
  it("lists origin-linked and edge-linked sessions newest first with agent, profile and span", () => {
    seedOriginLinked("old", "impl-old", "implementer", "2026-09-01T10:00:00Z");
    insertOrigin(fixture.graph.db, { sessionId: "edge", depth: 1, profile: "reviewer", agentName: "rev-1" });
    insertRequest(fixture.graph.db, { sessionId: "edge", ts: "2026-09-02T10:00:00Z", inputTokens: 1_000_000 });
    insertTaskEdge(fixture.graph, "edge", "T-1", "demo");
    seedOriginLinked("unrelated", "x", "implementer", "2026-09-03T10:00:00Z");
    fixture.graph.db.prepare("UPDATE session_origin SET task_ids = '[\"T-2\"]' WHERE session_id = 'unrelated'").run();

    const rows = taskLedger(fixture.openReadOnly(), "T-1");

    expect(rows.map((r) => r.sessionId)).toEqual(["edge", "old"]);
    expect(rows[0]).toMatchObject({ agentName: "rev-1", profile: "reviewer", startedAt: "2026-09-02T10:00:00Z", endedAt: "2026-09-02T10:00:00Z" });
    expect(rows[1]).toMatchObject({ agentName: "impl-old", profile: "implementer", startedAt: "2026-09-01T10:00:00Z", endedAt: "2026-09-01T11:00:00Z" });
  });

  it("prices each session from request_cost and flags a model with no price row", () => {
    seedOriginLinked("priced", "a", "implementer", "2026-09-01T10:00:00Z");
    insertOrigin(fixture.graph.db, { sessionId: "mystery", depth: 1 });
    fixture.graph.db.prepare("UPDATE session_origin SET task_ids = '[\"T-1\"]' WHERE session_id = 'mystery'").run();
    insertRequest(fixture.graph.db, { sessionId: "mystery", ts: "2026-09-01T09:00:00Z", model: "claude-mystery-9", inputTokens: 100 });

    const rows = taskLedger(fixture.openReadOnly(), "T-1");

    const priced = rows.find((r) => r.sessionId === "priced")!;
    const mystery = rows.find((r) => r.sessionId === "mystery")!;
    expect(priced.usd).toBeGreaterThan(0);
    expect(priced.unpriced).toBe(false);
    expect(mystery).toMatchObject({ usd: 0, unpriced: true });
  });

  it("joins linked PRs with state and merge time, and the review verdicts on them", () => {
    seedOriginLinked("impl", "a", "implementer", "2026-09-01T10:00:00Z");
    linkPr("impl", "o/r#5", "MERGED", "2026-09-01T12:00:00Z");
    verdict("gh:o/r#5:1", "o/r#5", "changes_requested", "2026-09-01T11:30:00Z");
    verdict("gh:o/r#5:2", "o/r#5", "approve", "2026-09-01T11:45:00Z");
    verdict("gh:o/r#9:1", "o/r#9", "approve", "2026-09-01T11:45:00Z");

    const [row] = taskLedger(fixture.openReadOnly(), "T-1");

    expect(row!.prs).toEqual([{ prRef: "o/r#5", state: "MERGED", mergedAt: "2026-09-01T12:00:00Z" }]);
    expect(row!.verdicts).toEqual([
      { prRef: "o/r#5", verdict: "changes_requested", ts: "2026-09-01T11:30:00Z" },
      { prRef: "o/r#5", verdict: "approve", ts: "2026-09-01T11:45:00Z" },
    ]);
  });

  it("gives an empty list for an unknown task", () => {
    seedOriginLinked("impl", "a", "implementer", "2026-09-01T10:00:00Z");

    expect(taskLedger(fixture.openReadOnly(), "T-404")).toEqual([]);
  });
});

describe("readTaskInitiative", () => {
  it("reads the initiative a task node names, and null for an unknown task", () => {
    insertTaskEdge(fixture.graph, "s", "T-1", "demo");

    expect(readTaskInitiative(fixture.openReadOnly(), "T-1")).toBe("demo");
    expect(readTaskInitiative(fixture.openReadOnly(), "T-404")).toBeNull();
  });
});
