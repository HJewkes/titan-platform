import { DEPTH_FLOOR_REASON, USAGE_LIMIT_REASON } from "@titan-design/review-panel";
import type { StepResult } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { lastAwaitClause, lastNoneReason } from "./none-reason.js";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

/** Step results oldest first, each stored under data.result as the writer stores them. */
function steps(...entries: [string, object][]): StepResult[] {
  return entries.map(([stepId, result], index) => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), data: { result } }));
}

const dispatched = { kind: "dispatched", reviewer: "rv-own", agentId: "agent-rv", sessionId: "s-1", startedAt: 1 };
const merge = (head: string) => ({ kind: "verdict", verdict: "MERGE", head, locator: {}, reviewer: { agentId: "agent-rv" } });
const awaited = (result: object) => steps([`sh-review:${H1}`, dispatched], [`sh-await-verdict:${H1}`, result]);

describe("the status line for the last await's none", () => {
  const cases: [string, StepResult[], string, string][] = [
    ["a seat WAIT named in its field", awaited({ kind: "none", reason: "seat check: anything", seat: "rv-seat-x" }), "seat-wait", "seat WAIT from rv-seat-x"],
    ["a seat WAIT recorded before the field, by its reason", awaited({ kind: "none", reason: `seat check: rv-seat-y said WAIT at ${H1}, so its required checks had not finished` }), "seat-wait", "seat WAIT from rv-seat-y"],
    ["a seat WAIT that held Shepherd's MERGE", awaited({ kind: "none", reason: `seat check: rv-seat-x said WAIT at ${H1}`, seatHeld: merge(H1) }), "seat-wait", "seat WAIT from rv-seat-x, Shepherd MERGE held"],
    ["a seat transcript that could not be read", awaited({ kind: "none", reason: "seat check: the roster could not be read: ECONNREFUSED" }), "seat-read", "the roster could not be read: ECONNREFUSED"],
    ["the usage limit with its reset", awaited({ kind: "none", reason: USAGE_LIMIT_REASON, notice: "You've hit your limit", resetsAt: Date.parse("2026-01-01T05:00:30Z") }), "usage-limit", "reviewer hit the usage limit (resets 2026-01-01T05:00Z)"],
    ["a malformed refusal", awaited({ kind: "none", malformed: { refusal: "multiple_blocks", writtenAt: 5 } }), "malformed", "malformed verdict refused: multiple_blocks"],
    ["a correction reply still malformed", steps([`sh-await-verdict:${H1}:corrected`, { kind: "none", malformed: { refusal: "bad_head", writtenAt: 5 } }]), "correction-failed", "the reviewer's verdict did not parse after one correction (bad_head)"],
    ["a correction ask the reviewer never got", steps([`sh-correct-verdict:${H1}`, { kind: "none", reason: "the resumed reviewer is in another session" }]), "correction-failed", "correction failed: the resumed reviewer is in another session"],
    ["the reviewer's own WAIT", awaited({ kind: "none", reason: "wait" }), "reviewer-wait", "reviewer said WAIT"],
    ["a verdict below the depth floor", awaited({ kind: "none", reason: DEPTH_FLOOR_REASON }), "depth-floor", "verdict below the depth floor"],
    ["the deadline", awaited({ kind: "none", ended: "deadline" }), "deadline", "no verdict before the wait ran out"],
    ["the reviewer exiting", awaited({ kind: "none", ended: "reviewer-gone" }), "reviewer-gone", "reviewer exited with no verdict"],
    ["a refused dispatch", steps([`sh-review:${H1}`, { kind: "none", reason: "the reviewer dispatch was refused: spawn-denied", refused: "spawn-denied" }]), "dispatch-refused", "dispatch refused: spawn-denied"],
    ["a dispatch that started no reviewer", steps([`sh-review:${H1}`, { kind: "none", notStarted: true }]), "not-started", "no reviewer started (broker busy)"],
    ["a none recorded before the end stamp", awaited({ kind: "none" }), "unknown", "no verdict read"],
  ];

  it.each(cases)("labels %s", (_scenario, recorded, kind, text) => {
    expect(lastNoneReason(recorded)).toEqual({ kind, text });
  });

  it("reads a seat WAIT over a malformed record as the seat WAIT", () => {
    const both = awaited({ kind: "none", reason: `seat check: rv-seat-x said WAIT at ${H1}`, malformed: { refusal: "multiple_blocks", writtenAt: 5 } });

    expect(lastNoneReason(both)?.kind).toBe("seat-wait");
  });

  it("cuts a long reason to 120 characters", () => {
    const text = lastNoneReason(awaited({ kind: "none", reason: `seat check: ${"x".repeat(200)}` }))?.text;

    expect(text).toHaveLength(120);
  });
});

describe("the last await", () => {
  it("has no none when a MERGE followed an earlier none", () => {
    expect(lastNoneReason(steps([`sh-await-verdict:${H1}`, { kind: "none", ended: "deadline" }], [`sh-late-verdict:${H1}`, merge(H1)]))).toBeUndefined();
  });

  it("reads a none at a newer head over an older head's MERGE", () => {
    expect(lastNoneReason(steps([`sh-await-verdict:${H1}`, merge(H1)], [`sh-await-verdict:${H2}`, { kind: "none", ended: "reviewer-gone" }]))?.kind).toBe("reviewer-gone");
  });

  it("ignores a panel member's await", () => {
    expect(lastNoneReason(steps([`sh-await-verdict:${H1}`, merge(H1)], [`sh-await-verdict:${H1}:security`, { kind: "none", ended: "deadline" }]))).toBeUndefined();
  });

  it("has no none while a started reviewer is still awaited", () => {
    expect(lastNoneReason(steps([`sh-await-verdict:${H1}`, { kind: "none", ended: "deadline" }], [`sh-review:${H2}`, dispatched]))).toBeUndefined();
  });

  it("reads a not-started dispatch stored at the top level of an older row", () => {
    const legacy: StepResult[] = [{ stepId: `sh-review:${H1}`, iteration: 0, agentId: null, signal: null, completedAt: "2026-01-01T00:00:00.000Z", data: { notStarted: true } }];

    expect(lastNoneReason(legacy)?.kind).toBe("not-started");
  });
});

describe("the last-await clause on a row", () => {
  const lastNone = { text: "seat WAIT from rv-seat-x" };

  it("names the last await", () => {
    expect(lastAwaitClause({ lastNone, stalled: null })).toBe("last await: seat WAIT from rv-seat-x");
  });

  it("says nothing when the stall line already names it", () => {
    expect(lastAwaitClause({ lastNone, stalled: { reason: "g10-review hold at 1111111 has no reviewer MERGE (last await: seat WAIT from rv-seat-x); 61 min" } })).toBeUndefined();
  });
});
