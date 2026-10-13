import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_FILL_COMPARISON, SUCCESSOR_REWORK_COMPARISON, compareWindows } from "./compare-windows.js";
import type { ReportWindow } from "./cost-report-queries.js";
import { createFixtureGraph, insertRequest, insertToolCall, type FixtureGraph } from "./fixture.js";
import { reviewFillReport, reviewFillSchema, type ReviewFillReport } from "./review-fill.js";
import type { SuccessorReworkReport } from "./successor-rework.js";

const BEFORE: ReportWindow = { since: "2026-09-20T10:00:00Z", until: "2026-09-20T10:30:00Z" };
const AFTER: ReportWindow = { since: "2026-09-20T10:30:00Z", until: "2026-09-21T00:00:00Z" };

type FillRow = ReviewFillReport["rows"][number];
type ReworkRow = SuccessorReworkReport["rows"][number];

function fillRow(row: Partial<FillRow>): FillRow {
  return { band: "100-200k", model: "m", verdicts: 4, changesRequested: 1, changesRate: 0.25, verdictErrors: 1, errorRate: 0.25, ...row };
}

function fillReport(window: ReportWindow, rows: FillRow[]): ReviewFillReport {
  return { window, unfilled: 0, unresolved: 0, rows };
}

function reworkReport(window: ReportWindow, fileReadData: boolean, rows: ReworkRow[]): SuccessorReworkReport {
  return { window, bootRequests: 30, fileReadData, rows };
}

function reworkRow(row: Partial<ReworkRow>): ReworkRow {
  return { role: "impl", pairs: 2, meanBootReads: 4, meanRereads: 1, rereadShare: 0.25, rereadCostUsd: 1.5, ...row };
}

/** A stub report run that answers each window with the rows given for its `since`. */
function stub<R>(byWindow: (window: ReportWindow) => R): { run: (window: ReportWindow) => R; calls: ReportWindow[] } {
  const calls: ReportWindow[] = [];
  return { calls, run: (window) => (calls.push(window), byWindow(window)) };
}

const isBefore = (window: ReportWindow) => window.since === BEFORE.since;

describe("compareWindows", () => {
  it("gives each delta as after minus before", () => {
    const { run } = stub((w) => fillReport(w, [isBefore(w) ? fillRow({ verdicts: 4, errorRate: 0.25 }) : fillRow({ verdicts: 6, errorRate: 0.5 })]));

    const [row] = compareWindows(run, BEFORE, AFTER, REVIEW_FILL_COMPARISON).rows;

    expect(row?.key).toBe("100-200k|m");
    expect(row?.delta.verdicts).toBe(2);
    expect(row?.delta.errorRate).toBe(0.25);
  });

  it("lists a key missing from one window with null deltas, not zeros", () => {
    const { run } = stub((w) => fillReport(w, isBefore(w) ? [fillRow({})] : [fillRow({}), fillRow({ band: "200k+", verdicts: 6 })]));

    const rows = compareWindows(run, BEFORE, AFTER, REVIEW_FILL_COMPARISON).rows;

    expect(rows.map((r) => r.key)).toEqual(["100-200k|m", "200k+|m"]);
    expect(rows[1]).toMatchObject({ before: null, delta: { verdicts: null, changesRate: null, errorRate: null } });
  });

  it("gives a null delta for a field that is null on one side while the other fields compute", () => {
    const { run } = stub((w) => fillReport(w, [isBefore(w) ? fillRow({ changesRate: null }) : fillRow({ verdicts: 5 })]));

    const [row] = compareWindows(run, BEFORE, AFTER, REVIEW_FILL_COMPARISON).rows;

    expect(row?.delta.changesRate).toBeNull();
    expect(row?.delta.verdicts).toBe(1);
  });

  it("gives every delta null when a window has no file_read data", () => {
    const { run } = stub((w) => (isBefore(w) ? reworkReport(w, false, [reworkRow({ meanRereads: 0, rereadCostUsd: 0 })]) : reworkReport(w, true, [reworkRow({})])));

    const [row] = compareWindows(run, BEFORE, AFTER, SUCCESSOR_REWORK_COMPARISON).rows;

    expect(row?.key).toBe("impl");
    expect(Object.values(row?.delta ?? {})).not.toHaveLength(0);
    expect(Object.values(row?.delta ?? {}).every((d) => d === null)).toBe(true);
  });

  it("returns both reports unchanged and runs each window once, before first", () => {
    const { run, calls } = stub((w) => fillReport(w, []));

    const result = compareWindows(run, BEFORE, AFTER, REVIEW_FILL_COMPARISON);

    expect(result.rows).toEqual([]);
    expect(result.before).toEqual(fillReport(BEFORE, []));
    expect(result.after).toEqual(fillReport(AFTER, []));
    expect(calls).toEqual([BEFORE, AFTER]);
  });
});

describe("compareWindows over reviewFillReport", () => {
  let fixture: FixtureGraph;
  beforeEach(() => {
    fixture = createFixtureGraph();
  });
  afterEach(() => fixture.close());

  const at = (minute: number) => `2026-09-20T10:${String(minute).padStart(2, "0")}:00Z`;

  function verdictBy(model: string, toolUseId: string, minute: number): void {
    const db = fixture.graph.db;
    insertRequest(db, { sessionId: "rev-1", ts: at(minute), model, inputTokens: 30_000, requestId: `req-${toolUseId}` });
    insertToolCall(db, { sessionId: "rev-1", ts: at(minute), toolUseId, name: "mcp__chat_send" });
    db.prepare(
      `INSERT INTO pr_review (source_key, surface, verdict, ts, session_id, transcript_id, number, pr_ref)
       VALUES (@key, 'chat', 'approve', @ts, 'rev-1', 1, 1, 'acme/widget#1')`,
    ).run({ key: `chat:${toolUseId}:0`, ts: at(minute) });
  }

  it("keys rows by band and model", () => {
    verdictBy("model-a", "tu-a", 0);
    verdictBy("model-a", "tu-b", 40);
    verdictBy("model-a", "tu-c", 45);
    verdictBy("model-b", "tu-d", 50);
    const db = fixture.openReadOnly();

    const result = compareWindows((w) => reviewFillReport(db, w), BEFORE, AFTER, REVIEW_FILL_COMPARISON);

    expect(result.rows.map((r) => [r.key, r.delta.verdicts])).toEqual([
      ["<50k|model-a", 1],
      ["<50k|model-b", null],
    ]);
    expect(reviewFillSchema.parse(result.before)).toEqual(result.before);
    expect(reviewFillSchema.parse(result.after)).toEqual(result.after);
  });
});
