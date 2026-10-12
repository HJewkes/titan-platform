import { describe, expect, it } from "vitest";
import { auditGate, auditRun, HOUR, iso, step } from "../test-support/owner-gate-audit.js";
import { outcomeFacts } from "./audit-facts.js";

const RESOLVED = Date.parse("2026-10-06T12:00:00Z");
const LATER = RESOLVED + 200 * HOUR;
const gate = auditGate({ id: "run-1/approve-merge:0", resolvedAt: RESOLVED });
const landed = step("sh-landed", RESOLVED + HOUR, { mergeSha: "abc123" });

describe("outcomeFacts", () => {
  it("reads a revert marked within 72 h of the resolve as reverted", () => {
    const run = auditRun("run-1", { "sh-landed": landed, "sh-reverted": step("sh-reverted", RESOLVED + 72 * HOUR) });

    const facts = outcomeFacts(gate, [run], [], LATER);

    expect(facts).toMatchObject({ decision: "merge", merged: true, mergeSha: "abc123", reverted: true, windowClosed: true });
  });

  it("does not hold a revert marked at 73 h against the decision", () => {
    const run = auditRun("run-1", { "sh-landed": landed, "sh-reverted": step("sh-reverted", RESOLVED + 73 * HOUR) });

    expect(outcomeFacts(gate, [run], [], LATER).reverted).toBe(false);
  });

  it("reads a red main CI read after the merge as main red", () => {
    const run = auditRun("run-1", { "sh-landed": landed, "sh-main-ci:0": step("sh-main-ci", RESOLVED + 2 * HOUR, { verdict: "red" }) });

    expect(outcomeFacts(gate, [run], [], LATER).mainRed).toBe(true);
  });

  it("keeps the window open for a resolve 10 h before now", () => {
    const run = auditRun("run-1", { "sh-landed": landed });

    expect(outcomeFacts(gate, [run], [], RESOLVED + 10 * HOUR).windowClosed).toBe(false);
  });

  it("links a deploy incident at the merge sha inside the window, and says unknown when no incidents were read", () => {
    const run = auditRun("run-1", { "sh-landed": landed });
    const incidents = [
      { at: iso(RESOLVED + 5 * HOUR), target: "abc123" },
      { at: iso(RESOLVED + 5 * HOUR), target: "fff999" },
    ];

    expect(outcomeFacts(gate, [run], incidents, LATER).incidents).toEqual([incidents[0]]);
    expect(outcomeFacts(gate, [run], undefined, LATER).incidents).toBe("unknown");
  });

  it("reports an unmerged decision with no run as not merged and nothing bad", () => {
    const facts = outcomeFacts(auditGate({ id: "gone/approve-merge:0", resolvedAt: RESOLVED, decision: "abandon" }), [], [], LATER);

    expect(facts).toEqual({ decision: "abandon", merged: false, reverted: false, mainRed: false, incidents: [], windowClosed: true });
  });
});
