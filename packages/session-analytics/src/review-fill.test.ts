import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertRequest, insertToolCall, type FixtureGraph } from "./fixture.js";
import { reviewFillReport, reviewFillSchema } from "./review-fill.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
});
afterEach(() => fixture.close());

const at = (minute: number) => `2026-09-20T10:${String(minute).padStart(2, "0")}:00Z`;
const PR = "acme/widget#1";

interface Verdict {
  key: string;
  verdict: "approve" | "changes_requested";
  ts: string;
  sessionId?: string;
  prRef?: string | null;
  surface?: "chat" | "gh";
}

function insertVerdict(v: Verdict): void {
  fixture.graph.db
    .prepare(
      `INSERT INTO pr_review (source_key, surface, verdict, ts, session_id, transcript_id, number, pr_ref)
       VALUES (@key, @surface, @verdict, @ts, @sessionId, 1, 1, @prRef)`,
    )
    .run({ surface: v.key.startsWith("gh:") ? "gh" : "chat", sessionId: "rev-1", prRef: PR, ...v });
}

/** A reviewer request with `contextTokens` of fill, then the tool use that posts a verdict, then a later small request. */
function reviewerTurn(toolUseId: string, contextTokens: number, minute: number, sessionId = "rev-1"): void {
  const db = fixture.graph.db;
  insertRequest(db, { sessionId, ts: at(minute), inputTokens: contextTokens, requestId: `req-${toolUseId}` });
  insertToolCall(db, { sessionId, ts: at(minute), toolUseId, name: "mcp__chat_send" });
  insertRequest(db, { sessionId, ts: at(minute + 1), inputTokens: 10_000, requestId: `next-${toolUseId}` });
}

const report = () => reviewFillReport(fixture.openReadOnly(), { since: "2026-09-20", until: "2026-09-21" });
const row = (band: string) => report().rows.find((r) => r.band === band);

describe("reviewFillReport", () => {
  it("places a verdict in the band of the request that issued it", () => {
    reviewerTurn("tu-a", 180_000, 0);
    insertVerdict({ key: "chat:tu-a:0", verdict: "approve", ts: at(0) });

    const result = report();

    expect(row("100-200k")?.verdicts).toBe(1);
    expect(row("<50k")).toBeUndefined();
    expect(result.unfilled).toBe(0);
    expect(reviewFillSchema.parse(result)).toEqual(result);
  });

  it("counts an approve followed by changes requested as one error, and the reverse order as none", () => {
    reviewerTurn("tu-a", 30_000, 0);
    reviewerTurn("tu-b", 30_000, 10, "rev-2");
    insertVerdict({ key: "chat:tu-a:0", verdict: "approve", ts: at(0) });
    insertVerdict({ key: "chat:tu-b:0", verdict: "changes_requested", ts: at(10), sessionId: "rev-2" });
    expect(row("<50k")).toMatchObject({ verdicts: 2, changesRequested: 1, verdictErrors: 1 });

    fixture.graph.db.prepare("UPDATE pr_review SET ts = CASE verdict WHEN 'approve' THEN ? ELSE ? END").run(at(10), at(0));
    expect(row("<50k")?.verdictErrors).toBe(0);
  });

  it("does not count an approve and changes requested with the same timestamp as an error", () => {
    reviewerTurn("tu-a", 30_000, 0);
    reviewerTurn("tu-b", 30_000, 0, "rev-2");
    insertVerdict({ key: "chat:tu-a:0", verdict: "approve", ts: at(0) });
    insertVerdict({ key: "chat:tu-b:0", verdict: "changes_requested", ts: at(0), sessionId: "rev-2" });
    expect(row("<50k")).toMatchObject({ verdicts: 2, verdictErrors: 0 });
  });

  it("ignores changes requested on a different PR", () => {
    reviewerTurn("tu-a", 30_000, 0);
    insertVerdict({ key: "chat:tu-a:0", verdict: "approve", ts: at(0) });
    insertVerdict({ key: "gh:other:1", verdict: "changes_requested", ts: at(10), prRef: "acme/gadget#1" });

    expect(row("<50k")?.verdictErrors).toBe(0);
  });

  it("counts a changes-requested review from GitHub as the contradiction of a chat approve", () => {
    reviewerTurn("tu-a", 30_000, 0);
    insertVerdict({ key: "chat:tu-a:0", verdict: "approve", ts: at(0) });
    insertVerdict({ key: "gh:acme/widget#1:t", verdict: "changes_requested", ts: at(10) });

    expect(row("<50k")?.verdictErrors).toBe(1);
  });

  it("counts a GitHub verdict as unfilled, not in a band", () => {
    insertVerdict({ key: "gh:acme/widget#1:t", verdict: "approve", ts: at(5) });

    const result = report();

    expect(result.unfilled).toBe(1);
    expect(result.rows).toEqual([]);
  });

  it("counts a verdict with no resolved PR instead of joining it", () => {
    reviewerTurn("tu-a", 30_000, 0);
    insertVerdict({ key: "chat:tu-a:0", verdict: "approve", ts: at(0), prRef: null });
    insertVerdict({ key: "gh:x:1", verdict: "changes_requested", ts: at(10), prRef: null });

    const result = report();

    expect(result.unresolved).toBe(2);
    expect(row("<50k")?.verdictErrors).toBe(0);
  });
});
