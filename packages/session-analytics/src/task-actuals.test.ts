import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, type FixtureGraph } from "./fixture.js";
import { taskActuals, type ActualsTask } from "./task-actuals.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
});
afterEach(() => fixture.close());

const MIN = 60_000;
const INITIATIVE = "alpha";
const OPTIONS = { initiatives: [INITIATIVE] };

function task(id: string, doneAt: string | null = "2026-09-20T12:00:00Z", initiative = INITIATIVE): ActualsTask {
  return { id, initiative, doneAt };
}

interface SessionSpec {
  id: string;
  profile?: string;
  tasks: string[];
  source?: string;
  /** Gaps in minutes between consecutive requests; the first request has none. */
  gaps: number[];
  start?: string;
  model?: string;
}

function addSession(spec: SessionSpec): void {
  const db = fixture.graph.db;
  insertOrigin(db, { sessionId: spec.id, depth: 1, profile: spec.profile ?? "implementer" });
  db.prepare("UPDATE session_origin SET task_ids = ?, task_source = ? WHERE session_id = ?").run(JSON.stringify(spec.tasks), spec.source ?? "name", spec.id);
  const model = spec.model ?? "claude-opus-5";
  let t = Date.parse(spec.start ?? "2026-09-20T09:00:00Z");
  insertRequest(db, { sessionId: spec.id, ts: new Date(t).toISOString(), outputTokens: 1000, model, gapMs: null });
  for (const gap of spec.gaps) {
    t += gap * MIN;
    insertRequest(db, { sessionId: spec.id, ts: new Date(t).toISOString(), outputTokens: 1000, model, gapMs: gap * MIN });
  }
}

function linkPr(sessionId: string, prRef: string, mergedAt: string | null): void {
  const db = fixture.graph.db;
  db.prepare("INSERT OR IGNORE INTO pr (pr_ref, merged_at) VALUES (?, ?)").run(prRef, mergedAt);
  fixture.graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "linked", targetRef: prRef });
}

describe("taskActuals", () => {
  it("caps each request gap and reports the 5 and 60 minute values beside the 15 minute one", () => {
    addSession({ id: "s1", tasks: ["T-1"], gaps: [2, 10, 30, 90] });

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

    expect(row!.implAgentHours.capped).toBeCloseTo((2 + 10 + 15 + 15) / 60);
    expect(row!.implAgentHours.at5m).toBeCloseTo((2 + 5 + 5 + 5) / 60);
    expect(row!.implAgentHours.at60m).toBeCloseTo((2 + 10 + 30 + 60) / 60);
    expect(row!.implSessions).toBe(1);
    expect(row!.flags).toEqual([]);
  });

  it("honours a different headline cap", () => {
    addSession({ id: "s1", tasks: ["T-1"], gaps: [30] });

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], { ...OPTIONS, capMinutes: 20 });

    expect(row!.implAgentHours.capped).toBeCloseTo(20 / 60);
  });

  it("prices cost over the linked sessions and records first and last implementer request", () => {
    addSession({ id: "s1", tasks: ["T-1"], gaps: [1], start: "2026-09-20T09:00:00Z" });
    addSession({ id: "s2", tasks: ["T-1"], gaps: [1], start: "2026-09-20T10:00:00Z" });

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

    expect(row!.usd).toBeGreaterThan(0);
    expect(row!.implSessions).toBe(2);
    expect(row!.firstImplAt).toBe("2026-09-20T09:00:00.000Z");
    expect(row!.lastImplAt).toBe("2026-09-20T10:01:00.000Z");
  });

  it("flags a done task with no implementer session", () => {
    const [row] = taskActuals(fixture.openReadOnly(), [task("T-9")], OPTIONS);

    expect(row!.flags).toEqual(["no-impl-session"]);
    expect(row!.implAgentHours.capped).toBe(0);
    expect(row!.firstImplAt).toBeNull();
  });

  it("flags weak-link for brief-paragraph and brief-anchor sources only", () => {
    addSession({ id: "s1", tasks: ["T-1"], gaps: [1], source: "brief-paragraph" });
    addSession({ id: "s2", tasks: ["T-2"], gaps: [1], source: "brief-anchor" });
    addSession({ id: "s3", tasks: ["T-3"], gaps: [1], source: "name-over-brief" });

    const rows = taskActuals(fixture.openReadOnly(), [task("T-1"), task("T-2"), task("T-3")], OPTIONS);

    expect(rows.map((r) => r.flags)).toEqual([["weak-link"], ["weak-link"], []]);
  });

  it("splits a multi-task session's hours and cost 1/k and flags every task it names", () => {
    addSession({ id: "s1", tasks: ["T-1", "T-2"], gaps: [10] });

    const rows = taskActuals(fixture.openReadOnly(), [task("T-1"), task("T-2")], OPTIONS);

    expect(rows[0]!.implAgentHours.capped).toBeCloseTo(5 / 60);
    expect(rows[1]!.implAgentHours.capped).toBeCloseTo(5 / 60);
    expect(rows[0]!.flags).toContain("multi-task");
    expect(rows[0]!.usd).toBeCloseTo(rows[1]!.usd);
  });

  it("flags reopened for an implementer session starting after done_at, and accepts a date-only done_at", () => {
    addSession({ id: "s1", tasks: ["T-1"], gaps: [1], start: "2026-09-21T09:00:00Z" });
    addSession({ id: "s2", tasks: ["T-2"], gaps: [1], start: "2026-09-20T22:00:00Z" });
    addSession({ id: "s3", tasks: ["T-3"], gaps: [1], start: "2026-09-21T09:00:00Z" });

    const rows = taskActuals(fixture.openReadOnly(), [task("T-1", "2026-09-20T12:00:00Z"), task("T-2", "2026-09-20"), task("T-3", "2026-09-20")], OPTIONS);

    expect(rows.map((r) => r.flags.includes("reopened"))).toEqual([true, false, true]);
  });

  it("flags unpriced when a session ran on a model with no price row", () => {
    addSession({ id: "s1", tasks: ["T-1"], gaps: [1], model: "unknown-model-x" });

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

    expect(row!.flags).toEqual(["unpriced"]);
  });

  it("attributes reviewer hours through the task id or the linked PR, and lists PRs with merge time", () => {
    addSession({ id: "impl", tasks: ["T-1"], gaps: [4] });
    addSession({ id: "rev-by-id", profile: "bd-reviewer", tasks: ["T-1"], gaps: [6] });
    addSession({ id: "rev-by-pr", profile: "reviewer", tasks: [], gaps: [3] });
    linkPr("impl", "acme/widget#7", "2026-09-20T11:00:00Z");
    linkPr("rev-by-pr", "acme/widget#7", "2026-09-20T11:00:00Z");

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

    expect(row!.reviewAgentHours.capped).toBeCloseTo((6 + 3) / 60);
    expect(row!.implAgentHours.capped).toBeCloseTo(4 / 60);
    expect(row!.prs).toEqual([{ prRef: "acme/widget#7", mergedAt: "2026-09-20T11:00:00Z" }]);
  });

  it("counts fable-implementer and fable-reviewer sessions as implementer and reviewer work", () => {
    addSession({ id: "impl", profile: "fable-implementer", tasks: ["T-1"], gaps: [8] });
    addSession({ id: "rev", profile: "fable-reviewer", tasks: ["T-1"], gaps: [6] });

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

    expect(row!.implAgentHours.capped).toBeCloseTo(8 / 60);
    expect(row!.reviewAgentHours.capped).toBeCloseTo(6 / 60);
    expect(row!.flags).toEqual([]);
    expect(row!.unmappedSessions).toBe(0);
  });

  it("reports a task-linked session with an unmapped profile instead of dropping it silently", () => {
    addSession({ id: "impl", tasks: ["T-1"], gaps: [4] });
    addSession({ id: "odd", profile: "brand-new-profile", tasks: ["T-1"], gaps: [9] });
    addSession({ id: "planner", profile: "planner", tasks: ["T-1"], gaps: [9] });

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

    expect(row!.flags).toEqual(["unmapped-role"]);
    expect(row!.unmappedSessions).toBe(1);
    expect(row!.implAgentHours.capped).toBeCloseTo(4 / 60);
  });

  it("rejects a non-positive cap", () => {
    expect(() => taskActuals(fixture.openReadOnly(), [], { ...OPTIONS, capMinutes: 0 })).toThrow(RangeError);
  });

  it("gives no row to a task outside the allowlist or not done", () => {
    addSession({ id: "s1", tasks: ["P-1"], gaps: [1] });

    const rows = taskActuals(fixture.openReadOnly(), [task("P-1", "2026-09-20T12:00:00Z", "personal"), task("T-5", null)], OPTIONS);

    expect(rows).toEqual([]);
  });
});
