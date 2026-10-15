import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, insertSignal, type FixtureGraph } from "./fixture.js";
import { taskActuals, type ActualsTask } from "./task-actuals.js";
import type { Db } from "@titan-design/store-sqlite";

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

/** One request per entry at 09:MM, its context carried as input tokens. */
function addContexts(sessionId: string, contexts: Record<string, number>): void {
  for (const [minute, context] of Object.entries(contexts)) {
    insertRequest(fixture.graph.db, { sessionId, ts: `2026-09-20T09:${minute}:00.000Z`, inputTokens: context });
  }
}

function addSignal(sessionId: string, minute: string, signal: string): void {
  insertSignal(fixture.graph.db, { sessionId, ts: `2026-09-20T09:${minute}:00.000Z`, signal });
}

function at(minute: string): string {
  return `2026-09-20T09:${minute}:00.000Z`;
}

function numberField(row: unknown, key: string): number | null {
  const value: unknown = typeof row === "object" && row !== null ? Reflect.get(row, key) : null;
  return typeof value === "number" ? value : null;
}

// The pre-TP-2568 per-task reads through the request_cost view, kept as the oracle for the batched pass.
function oraclePeak(db: Db, sessionIds: string[]): number | null {
  const row: unknown = db
    .prepare("SELECT MAX(context_tokens) AS peak FROM request_cost WHERE session_id IN (SELECT value FROM json_each(@ids)) AND is_sidechain = 0")
    .get({ ids: JSON.stringify(sessionIds) });
  return numberField(row, "peak");
}

function oracleFirstDeliverable(db: Db, sessionIds: string[]): number | null {
  const row: unknown = db
    .prepare(
      `WITH first AS (
         SELECT session_id, ts FROM session_signal WHERE session_id IN (SELECT value FROM json_each(@ids)) AND signal IN ('status_report', 'pr_create')
         ORDER BY ts, byte_offset LIMIT 1)
       SELECT r.context_tokens AS context FROM request_cost r JOIN first f ON r.session_id = f.session_id
       WHERE r.is_sidechain = 0 AND r.ts >= f.ts ORDER BY r.ts LIMIT 1`,
    )
    .get({ ids: JSON.stringify(sessionIds) });
  return numberField(row, "context");
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

  it("counts every task-linked session outside the two totals in unmappedSessions", () => {
    addSession({ id: "impl", tasks: ["T-1"], gaps: [4] });
    addSession({ id: "odd", profile: "brand-new-profile", tasks: ["T-1"], gaps: [9] });
    addSession({ id: "planner", profile: "planner", tasks: ["T-1"], gaps: [9] });

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

    expect(row!.flags).toEqual(["unmapped-role"]);
    expect(row!.unmappedSessions).toBe(2);
    expect(row!.implAgentHours.capped).toBeCloseTo(4 / 60);
  });

  it("keeps a resumed implementer that outlived 12 hours with two assignment episodes", () => {
    addSession({ id: "impl", tasks: ["T-1"], gaps: [10, 13 * 60, 10] });
    const db = fixture.graph.db;
    for (const [index, openedBy] of ["brief", "channel_followup"].entries()) {
      db.prepare(
        `INSERT INTO episode (session_id, episode_index, heuristic, heuristic_version, started_at, ended_at, start_offset, end_offset, opened_by)
         VALUES ('impl', ?, 'worker-v1', 1, '2026-09-20T09:00:00Z', '2026-09-20T09:10:00Z', 0, 1, ?)`,
      ).run(index, openedBy);
    }

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1", "2026-09-30T00:00:00Z")], OPTIONS);

    expect(row!.implSessions).toBe(1);
    expect(row!.implAgentHours.capped).toBeCloseTo((10 + 15 + 10) / 60);
    expect(row!.flags).toEqual([]);
    expect(row!.unmappedSessions).toBe(0);
  });

  it("rejects a non-positive cap", () => {
    expect(() => taskActuals(fixture.openReadOnly(), [], { ...OPTIONS, capMinutes: 0 })).toThrow(RangeError);
  });

  it("gives no row to a task outside the allowlist or not done", () => {
    addSession({ id: "s1", tasks: ["P-1"], gaps: [1] });

    const rows = taskActuals(fixture.openReadOnly(), [task("P-1", "2026-09-20T12:00:00Z", "personal"), task("T-5", null)], OPTIONS);

    expect(rows).toEqual([]);
  });

  describe("context", () => {
    it("takes the context of the first implementer request after a pr_create, and the peak over all of them", () => {
      addSession({ id: "impl", tasks: ["T-1"], gaps: [] });
      addContexts("impl", { "10": 40_000, "20": 90_000, "30": 120_000, "40": 70_000 });
      addSignal("impl", "15", "pr_create");

      const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

      expect(row!.contextAtFirstDeliverable).toBe(90_000);
      expect(row!.peakContext).toBe(120_000);
    });

    it("lets an earlier status_report win over a later pr_create, across implementer sessions", () => {
      addSession({ id: "first", tasks: ["T-1"], gaps: [] });
      addSession({ id: "second", tasks: ["T-1"], gaps: [] });
      addContexts("first", { "10": 30_000, "40": 80_000 });
      addContexts("second", { "20": 50_000, "30": 60_000 });
      addSignal("second", "25", "pr_create");
      addSignal("first", "15", "status_report");

      const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

      expect(row!.contextAtFirstDeliverable).toBe(80_000);
      expect(row!.peakContext).toBe(80_000);
    });

    it("leaves contextAtFirstDeliverable null with no deliverable signal but still reports the peak", () => {
      addSession({ id: "impl", tasks: ["T-1"], gaps: [] });
      addContexts("impl", { "10": 40_000, "20": 55_000 });
      addSignal("impl", "15", "commit");

      const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

      expect(row!.contextAtFirstDeliverable).toBeNull();
      expect(row!.peakContext).toBe(55_000);
    });

    it("counts no reviewer request or signal toward either value", () => {
      addSession({ id: "impl", tasks: ["T-1"], gaps: [] });
      addSession({ id: "rev", profile: "reviewer", tasks: ["T-1"], gaps: [] });
      addContexts("impl", { "10": 40_000, "30": 45_000 });
      addContexts("rev", { "10": 150_000, "20": 160_000 });
      addSignal("rev", "15", "status_report");
      addSignal("impl", "20", "pr_create");

      const [row] = taskActuals(fixture.openReadOnly(), [task("T-1")], OPTIONS);

      expect(row!.contextAtFirstDeliverable).toBe(45_000);
      expect(row!.peakContext).toBe(45_000);
    });

    it("reports null for both when the task has no implementer session", () => {
      const [row] = taskActuals(fixture.openReadOnly(), [task("T-9")], OPTIONS);

      expect(row!.peakContext).toBeNull();
      expect(row!.contextAtFirstDeliverable).toBeNull();
    });

    it("matches the per-task request_cost reads with request copies, sidechains and shared sessions", () => {
      addSession({ id: "a", tasks: ["T-1", "T-2"], gaps: [] });
      addSession({ id: "b", tasks: ["T-2"], gaps: [] });
      addSession({ id: "c", tasks: ["T-3"], gaps: [] });
      addSession({ id: "d", tasks: ["T-3"], gaps: [] });
      addContexts("a", { "10": 40_000, "30": 90_000 });
      insertRequest(fixture.graph.db, { sessionId: "a", ts: at("12"), requestId: "copied", inputTokens: 70_000 });
      insertRequest(fixture.graph.db, { sessionId: "b", ts: at("17"), requestId: "copied", transcriptId: 2, inputTokens: 200_000 });
      addContexts("b", { "11": 30_000, "18": 60_000 });
      addSignal("a", "25", "status_report");
      addSignal("b", "15", "pr_create");
      addContexts("c", { "10": 50_000, "20": 80_000 });
      insertRequest(fixture.graph.db, { sessionId: "c", ts: at("55"), isSidechain: true, inputTokens: 300_000 });
      addSignal("c", "50", "status_report");
      addSignal("d", "52", "pr_create");
      addContexts("d", { "53": 65_000 });
      const db = fixture.openReadOnly();
      const implIds: Record<string, string[]> = { "T-1": ["a"], "T-2": ["a", "b"], "T-3": ["c", "d"] };

      const rows = taskActuals(db, [task("T-1"), task("T-2"), task("T-3")], OPTIONS);

      expect(rows.map((r) => [r.taskId, r.peakContext, r.contextAtFirstDeliverable])).toEqual(
        rows.map((r) => [r.taskId, oraclePeak(db, implIds[r.taskId]!), oracleFirstDeliverable(db, implIds[r.taskId]!)]),
      );
      expect(rows.map((r) => [r.peakContext, r.contextAtFirstDeliverable])).toEqual([
        [90_000, 90_000],
        [90_000, 60_000],
        [80_000, null],
      ]);
    });

    it("reads requests the same number of times for 2 tasks as for 20", () => {
      const requestReads = (taskCount: number): number => {
        const tasks = Array.from({ length: taskCount }, (_, i) => `T-${taskCount}-${i}`);
        for (const id of tasks) {
          addSession({ id: `s-${id}`, tasks: [id], gaps: [1] });
          addSignal(`s-${id}`, "00", "pr_create");
        }
        const db = fixture.openReadOnly();
        const prepare = vi.spyOn(db, "prepare");
        taskActuals(db, tasks.map((id) => task(id)), OPTIONS);
        return prepare.mock.calls.filter(([sql]) => /\brequest(_cost)?\b/.test(sql)).length;
      };

      expect(requestReads(20)).toBe(requestReads(2));
    });
  });
});
