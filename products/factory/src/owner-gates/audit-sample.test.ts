import { describe, expect, it } from "vitest";
import { auditGate, HOUR } from "../test-support/owner-gate-audit.js";
import { sampleOwnerGates, weekBounds, weekSeed } from "./audit-sample.js";

const W41 = Date.parse("2026-10-05T00:00:00Z");
const W42 = Date.parse("2026-10-12T00:00:00Z");

const ownerGates = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => auditGate({ id: `run-${i}/approve-merge:0`, resolvedAt: start + (i + 1) * HOUR }));

describe("weekBounds", () => {
  it("starts an ISO week on its Monday and spans seven days", () => {
    expect(weekBounds("2026-W41")).toEqual({ start: W41, end: W42 });
    expect(weekBounds("2026-W01").start).toBe(Date.parse("2025-12-29T00:00:00Z"));
  });

  it("refuses text that is not an ISO week, and a week the year does not have", () => {
    expect(() => weekBounds("2026-41")).toThrow(/ISO week/);
    expect(() => weekBounds("2025-W53")).toThrow(/no week 53/);
  });
});

describe("sampleOwnerGates", () => {
  it("draws the same five gates for the same week whatever order the store read them in", () => {
    const gates = ownerGates(W41, 12);

    const first = sampleOwnerGates(gates, "2026-W41").map((gate) => gate.id);
    const again = sampleOwnerGates([...gates].reverse(), "2026-W41").map((gate) => gate.id);

    expect(first).toHaveLength(5);
    expect(again).toEqual(first);
  });

  it("draws a fixed sample for a past week, so a rerun months later audits the same decisions", () => {
    const ids = sampleOwnerGates(ownerGates(W41, 12), "2026-W41").map((gate) => gate.id);

    expect(ids).toEqual(["run-1/approve-merge:0", "run-11/approve-merge:0", "run-7/approve-merge:0", "run-5/approve-merge:0", "run-9/approve-merge:0"]);
  });

  it("orders another week's identical population differently, because the seed is the week", () => {
    const w41 = sampleOwnerGates(ownerGates(W41, 12), "2026-W41", 12).map((gate) => gate.id);
    const w42 = sampleOwnerGates(ownerGates(W42, 12), "2026-W42", 12).map((gate) => gate.id);

    expect(weekSeed("2026-W41")).not.toBe(weekSeed("2026-W42"));
    expect(w42).not.toEqual(w41);
  });

  it("returns every eligible gate when the week has fewer than five", () => {
    expect(sampleOwnerGates(ownerGates(W41, 3), "2026-W41")).toHaveLength(3);
  });

  it("leaves out non-owner resolvers, delegate grants, unresolved gates and other weeks", () => {
    const gates = [
      auditGate({ id: "a/approve-merge:0", resolvedAt: W41 + HOUR, by: "automation" }),
      auditGate({ id: "b/approve-merge:0", resolvedAt: W41 + HOUR, by: "coordinator" }),
      auditGate({ id: "c/approve-merge:0", resolvedAt: W41 + HOUR, evidence: { grant: "merge-on-green-approve" } }),
      auditGate({ id: "d/approve-merge:0", status: "cancelled" }),
      auditGate({ id: "e/approve-merge:0", status: "pending" }),
      auditGate({ id: "f/approve-merge:0", resolvedAt: W42 + HOUR }),
      auditGate({ id: "g/approve-merge:0", resolvedAt: W41 + HOUR, by: "owner-remote" }),
    ];

    expect(sampleOwnerGates(gates, "2026-W41").map((gate) => gate.id)).toEqual(["g/approve-merge:0"]);
  });
});
