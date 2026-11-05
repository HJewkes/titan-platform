import { describe, expect, it } from "vitest";
import { auditGate, auditRun, HOUR, iso, step } from "../test-support/owner-gate-audit.js";
import { outcomeFacts, type AuditIncident, type IncidentLinks } from "./audit-facts.js";

const RESOLVED = Date.parse("2026-10-06T12:00:00Z");
const LATER = RESOLVED + 200 * HOUR;
const gate = auditGate({ id: "run-1/approve-merge:0", resolvedAt: RESOLVED });
const landed = step("sh-landed", RESOLVED + HOUR, { mergeSha: "abc123" });
const linksOf = (linked: AuditIncident[] | "unknown"): IncidentLinks => new Map([["abc123", linked]]);
const NONE_LINKED = linksOf([]);

describe("outcomeFacts", () => {
  it("reads a revert marked within 72 h of the resolve as reverted", () => {
    const run = auditRun("run-1", { "sh-landed": landed, "sh-reverted": step("sh-reverted", RESOLVED + 72 * HOUR) });

    const facts = outcomeFacts(gate, [run], NONE_LINKED, LATER);

    expect(facts).toMatchObject({ decision: "merge", merged: true, mergeSha: "abc123", reverted: true, windowClosed: true });
  });

  it("does not hold a revert marked at 73 h against the decision", () => {
    const run = auditRun("run-1", { "sh-landed": landed, "sh-reverted": step("sh-reverted", RESOLVED + 73 * HOUR) });

    expect(outcomeFacts(gate, [run], NONE_LINKED, LATER).reverted).toBe(false);
  });

  it("reads a red main CI read after the merge as main red", () => {
    const run = auditRun("run-1", { "sh-landed": landed, "sh-main-ci:0": step("sh-main-ci", RESOLVED + 2 * HOUR, { verdict: "red" }) });

    expect(outcomeFacts(gate, [run], NONE_LINKED, LATER).mainRed).toBe(true);
  });

  it("keeps the window open for a resolve 10 h before now", () => {
    const run = auditRun("run-1", { "sh-landed": landed });

    expect(outcomeFacts(gate, [run], NONE_LINKED, RESOLVED + 10 * HOUR).windowClosed).toBe(false);
  });

  it("links an incident to the merge only inside the window", () => {
    const run = auditRun("run-1", { "sh-landed": landed });
    const inWindow = { at: iso(RESOLVED + 5 * HOUR), target: "abc123", from: "000aaa" };
    const after = { at: iso(RESOLVED + 80 * HOUR), target: "abc123", from: "000aaa" };

    expect(outcomeFacts(gate, [run], linksOf([inWindow, after]), LATER).incidents).toEqual([inWindow]);
  });

  it("says zero, not unknown, when incident records exist and none match", () => {
    const run = auditRun("run-1", { "sh-landed": landed });

    expect(outcomeFacts(gate, [run], NONE_LINKED, LATER).incidents).toEqual([]);
  });

  it("says unknown when no incident records were read", () => {
    const run = auditRun("run-1", { "sh-landed": landed });

    expect(outcomeFacts(gate, [run], undefined, LATER).incidents).toBe("unknown");
  });

  it("says unknown when the merge's ancestry could not be read", () => {
    const run = auditRun("run-1", { "sh-landed": landed });

    expect(outcomeFacts(gate, [run], linksOf("unknown"), LATER).incidents).toBe("unknown");
  });

  it("reports an unmerged decision with no run as not merged and nothing bad", () => {
    const facts = outcomeFacts(auditGate({ id: "gone/approve-merge:0", resolvedAt: RESOLVED, decision: "abandon" }), [], NONE_LINKED, LATER);

    expect(facts).toEqual({ decision: "abandon", merged: false, reverted: false, mainRed: false, incidents: [], windowClosed: true });
  });
});
