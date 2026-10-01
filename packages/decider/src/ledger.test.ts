import { describe, expect, it } from "vitest";
import { v1Row } from "./fixtures.js";
import { LedgerRowSchema } from "./ledger.js";

describe("LedgerRowSchema reading a v1 precedent row", () => {
  it("parses it with v defaulting to 1 and class carried into category", () => {
    const row = LedgerRowSchema.parse(v1Row());

    expect(row.v).toBe(1);
    expect(row.category).toBe("tech_design");
    expect(row.options[1]).toEqual({ label: "Use a cron job" });
    expect(row.recommended).toBe("Use a queue");
  });

  it("derives the outcome from the pick type", () => {
    const row = LedgerRowSchema.parse(
      v1Row({ answer: "Use a queue but only on weekdays", pick_type: "free_text" }),
    );

    expect(row.outcome).toBe("amend");
  });

  it("fills the v2 fields a v1 row lacks with their defaults", () => {
    const row = LedgerRowSchema.parse(v1Row());

    expect(row).toMatchObject({
      answered_at: null,
      locator: null,
      answered_by: "owner-terminal",
      route: null,
      prediction: null,
      unclaimed: false,
    });
  });

  it("keeps a rejected v1 row out of scoring", () => {
    const row = LedgerRowSchema.parse(v1Row({ answer: null, pick_type: "rejected" }));

    expect(row.outcome).toBeNull();
  });

  it("keeps an unparsed v1 row out of scoring", () => {
    const row = LedgerRowSchema.parse(v1Row({ answer: null, pick_type: "unparsed" }));

    expect(row.outcome).toBeNull();
  });
});

describe("LedgerRowSchema reading a v2 row", () => {
  const v2 = {
    key: "decided:msg-42",
    v: 2 as const,
    source: "decided" as const,
    asked_at: "2026-01-02T03:04:05.000Z",
    answered_at: "2026-01-02T03:05:00.000Z",
    locator: { path: "/var/example/events.db", msgId: "msg-42" },
    initiative: "widgets",
    category: "agent_ops",
    header: "Retry",
    question: "Retry the failed widget build?",
    options: [{ label: "Retry once", description: "Same inputs" }, { label: "Skip" }],
    recommended: "Retry once",
    answer: "Retry once",
    outcome: "accept" as const,
    answered_by: "decider" as const,
    route: "decider" as const,
    prediction: { answer: "Retry once", confidence: 0.92, principleIds: ["p-1"], escalate: false },
  };

  it("keeps the stated version, outcome and provenance", () => {
    const row = LedgerRowSchema.parse(v2);

    expect(row).toMatchObject({ v: 2, outcome: "accept", answered_by: "decider", route: "decider" });
    expect(row.locator).toEqual({ path: "/var/example/events.db", msgId: "msg-42" });
  });

  it("rejects an outcome outside the vocabulary", () => {
    expect(LedgerRowSchema.safeParse({ ...v2, outcome: "maybe" }).success).toBe(false);
  });

  it("rejects a prediction confidence above 1", () => {
    const prediction = { ...v2.prediction, confidence: 1.5 };

    expect(LedgerRowSchema.safeParse({ ...v2, prediction }).success).toBe(false);
  });
});
