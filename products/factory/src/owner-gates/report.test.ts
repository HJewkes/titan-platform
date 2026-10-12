import type { GateRecord } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { HOUR, auditGate, iso } from "../test-support/owner-gate-audit.js";
import { formatOwnerGatesReport, ownerGatesReport } from "./report.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const AUTHORITY = "Merge? Policy authority/MRG-AU: owner merges";
const NO_SEATS = { seats: [], denied: [] };
const DELEGATE = { kind: "delegate", delegate: "tp-operator", grant: "item 193" };

let serial = 0;

function merge(decision: string, extra: Partial<GateRecord> = {}): GateRecord {
  serial += 1;
  return { ...auditGate({ id: `run-${serial}/approve-merge:0`, resolvedAt: NOW - 24 * HOUR, decision }), prompt: AUTHORITY, ...extra };
}

/** `approved` merges and the rest abandons, all owner-answered in the window. */
const answered = (approved: number, total: number): GateRecord[] =>
  Array.from({ length: total }, (_, i) => merge(i < approved ? "merge" : "abandon"));

const report = (gates: readonly GateRecord[], auditBad?: Map<string, string[]>) => ownerGatesReport(gates, { now: NOW, seats: NO_SEATS, auditBad });
const flaggedClasses = (gates: readonly GateRecord[]): string[] => report(gates).flagged.map((flag) => flag.class);

describe("ownerGatesReport", () => {
  it("flags a class at or above 95% approve only once 20 or more owner-answered gates back it", () => {
    expect(flaggedClasses(answered(20, 20))).toEqual(["D4"]);
    expect(flaggedClasses(answered(19, 20))).toEqual(["D4"]);
    expect(flaggedClasses(answered(18, 20))).toEqual([]);
    expect(flaggedClasses(answered(19, 19))).toEqual([]);
  });

  it("prints per class the answered count, approve rate, cancelled-unanswered and median wait", () => {
    const cancelled = merge("merge", { status: "cancelled", payload: undefined, resolvedBy: undefined, resolvedAt: iso(NOW - 20 * HOUR) });

    const { classes } = report([...answered(3, 4), cancelled]);

    expect(classes).toEqual([{ class: "D4", answered: 4, approved: 3, rate: 0.75, cancelledUnanswered: 1, medianWaitHours: 2 }]);
  });

  it("counts each step's own proceed option as approve, so a rerun on a red CI is an approve", () => {
    const ciFailed = { ...auditGate({ id: "run-ci/ci-failed:0", resolvedAt: NOW - HOUR, decision: "rerun" }) };

    expect(report([ciFailed]).classes).toEqual([expect.objectContaining({ class: "D16", answered: 1, approved: 1 })]);
  });

  it("holds a flagged class the audit found a bad outcome in, and says why", () => {
    const result = report(answered(20, 20), new Map([["D4", ["reverted"]]]));

    expect(result.flagged).toEqual([expect.objectContaining({ class: "D4", held: ["audit found reverted"] })]);
    expect(formatOwnerGatesReport(result)).toContain("flag D4  20/20 approved (100%)  held: audit found reverted");
  });

  it("proposes a demotion for an unheld flag", () => {
    expect(formatOwnerGatesReport(report(answered(20, 20)))).toContain("flag D4  20/20 approved (100%)  propose demotion to a (rule), b (reviewer) or c (decider)");
  });

  it("leaves a resolve made under a grant out of the class rate and lists it under its grant", () => {
    const granted = merge("abandon", { resolvedBy: { class: "coordinator", id: "tp-operator", channel: "factory-cli" }, resolvedEvidence: DELEGATE });

    const result = report([...answered(20, 20), granted]);

    expect(result.classes[0]).toMatchObject({ answered: 20, approved: 20 });
    expect(result.grants).toEqual([{ grant: "item 193", source: "delegate", resolved: 1, gateIds: [granted.id] }]);
  });

  it("ignores gates opened before the 14-day window", () => {
    const old = merge("merge", { createdAt: iso(NOW - 15 * 24 * HOUR), resolvedAt: iso(NOW - 15 * 24 * HOUR + HOUR) });

    expect(report([old]).classes).toEqual([]);
  });

  it("says from when provenance is reliable when the first granted resolve falls inside the window", () => {
    const granted = merge("merge", { resolvedEvidence: DELEGATE });

    const result = report([granted]);

    expect(result.provenanceFrom).toBe(granted.resolvedAt);
    expect(formatOwnerGatesReport(result)).toContain(`provenance reliable from ${granted.resolvedAt}`);
  });
});
