import { PlaybookStore, applyMaturity, memoryMigration } from "@titan-design/memory";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFeedback, feedbackForRow } from "./feedback.js";
import { v1Row } from "./fixtures.js";
import { LedgerRowSchema, type LedgerRowWire } from "./ledger.js";
import { principleBullet } from "./principles.js";

const NOW = new Date("2026-03-01T00:00:00Z");

function row(overrides: Partial<LedgerRowWire> = {}) {
  return LedgerRowSchema.parse(v1Row({ answered_at: "2026-02-01T00:00:00Z", ...overrides }));
}

describe("feedbackForRow", () => {
  it("maps agreement to helpful and contradiction to harmful, keyed by the ledger row", () => {
    const mapping = feedbackForRow(row(), [
      { principleId: "p1", verdict: "agrees" },
      { principleId: "p2", verdict: "contradicts", reason: "owner picked cron" },
    ]);

    expect(mapping.feedback).toEqual([
      { principleId: "p1", type: "helpful", sessionRef: "ledger:transcript:sess-0001:toolu_0001", at: "2026-02-01T00:00:00Z", reason: null },
      { principleId: "p2", type: "harmful", sessionRef: "ledger:transcript:sess-0001:toolu_0001", at: "2026-02-01T00:00:00Z", reason: "owner picked cron" },
    ]);
  });

  it("never counts the decider's own answers as evidence", () => {
    const mapping = feedbackForRow(row({ v: 2, answered_by: "decider" }), [{ principleId: "p1", verdict: "agrees" }]);

    expect(mapping).toEqual({ feedback: [], skipped: "decider-answer" });
  });

  it("skips unclaimed rows and unparsed answers", () => {
    expect(feedbackForRow(row({ unclaimed: true }), [{ principleId: "p1", verdict: "agrees" }])).toEqual({ feedback: [], skipped: "unclaimed" });
    expect(feedbackForRow(row({ pick_type: "unparsed" }), [{ principleId: "p1", verdict: "agrees" }])).toEqual({ feedback: [], skipped: "unscored" });
  });

  it("turns an overrule into harmful feedback on every principle the decider cited", () => {
    const overrule = row({
      v: 2,
      answered_by: "overrule",
      prediction: { answer: "Use a queue", confidence: 0.9, principleIds: ["p1", "p2"], escalate: false },
    });

    const mapping = feedbackForRow(overrule, [{ principleId: "p1", verdict: "agrees" }, { principleId: "p3", verdict: "agrees" }]);

    expect(mapping.feedback.map((f) => [f.principleId, f.type])).toEqual([
      ["p1", "harmful"],
      ["p2", "harmful"],
      ["p3", "helpful"],
    ]);
  });

  it("falls back to the ask time when the row has no answer time", () => {
    const [first] = feedbackForRow(row({ answered_at: null }), [{ principleId: "p1", verdict: "agrees" }]).feedback;

    expect(first?.at).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("applyFeedback", () => {
  let db: Db;
  let store: PlaybookStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = new PlaybookStore(db, { now: () => NOW });
  });

  afterEach(() => db.close());

  it("records each ledger key once per principle and reports unknown principles", () => {
    const { id } = store.add(principleBullet({ rule: "Prefer a queue", domain: "tech_design", citedKeys: [] }));
    const { feedback } = feedbackForRow(row(), [{ principleId: id, verdict: "agrees" }, { principleId: "missing", verdict: "agrees" }]);

    const first = applyFeedback(store, feedback);
    const second = applyFeedback(store, feedback);

    expect(first.recorded.map((f) => f.principleId)).toEqual([id]);
    expect(first.unknown.map((f) => f.principleId)).toEqual(["missing"]);
    expect(second.duplicate.map((f) => f.principleId)).toEqual([id]);
    expect(store.feedbackFor(id)).toEqual([expect.objectContaining({ type: "helpful", sessionRef: "ledger:transcript:sess-0001:toolu_0001", at: "2026-02-01T00:00:00Z" })]);
  });

  it("lets two recent contradictions demote an established principle", () => {
    const { id } = store.add(principleBullet({ rule: "Prefer a queue", domain: "tech_design", citedKeys: [] }));
    for (const n of [1, 2, 3, 4]) {
      applyFeedback(store, feedbackForRow(row({ key: `queue:${n}`, answered_at: "2026-02-25T00:00:00Z" }), [{ principleId: id, verdict: "agrees" }]).feedback);
    }
    applyMaturity(store, NOW);
    expect(store.require(id).maturity).toBe("established");

    for (const n of [5, 6]) {
      applyFeedback(store, feedbackForRow(row({ key: `queue:${n}`, answered_at: "2026-02-28T00:00:00Z" }), [{ principleId: id, verdict: "contradicts" }]).feedback);
    }
    applyMaturity(store, NOW);

    expect(store.require(id).maturity).not.toBe("established");
  });
});
