import { describe, expect, it } from "vitest";
import { BY_REC_RESOLVER, BY_REC_ROW_SCHEMA, type ByRecRow } from "@titan-design/owner-queue";
import { approvalOf } from "./log-approval.js";
import { digestLine, logCounts, mergeLog, type ShipInput } from "./log-rows.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HOUR = 3_600_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function ship(pr: number, approval: ShipInput["approval"], hoursAgo = 1): ShipInput {
  return { repo: "orbit/relay", pr, task: `OR-${pr}`, url: `https://github.com/orbit/relay/pull/${pr}`, mergedAt: NOW - hoursAgo * HOUR, approval };
}

function byRec(overrides: Partial<ByRecRow> & Pick<ByRecRow, "mode">): ByRecRow {
  return {
    schema: BY_REC_ROW_SCHEMA, subject: { source: "gate", id: "gate-1" }, recommendation: { answer: "merge", by: "relay-reviewer", rationale: "MERGE at head" },
    openedAt: new Date(NOW - 30 * HOUR).toISOString(), resolvedAt: new Date(NOW - 2 * HOUR).toISOString(), facts: {},
    result: overrides.mode === "live" ? "resolved" : "would-resolve", resolver: { ...BY_REC_RESOLVER }, ...overrides,
  };
}

const gate = (pr: number, mode: ByRecRow["mode"], repo = "orbit/relay"): ByRecRow => byRec({ subject: { source: "gate", id: `gate-${pr}-${mode}` }, facts: { repo, pr }, mode });

describe("the log merge", () => {
  it("merges ships, gate rows and console rows with one row per PR", () => {
    const rows = mergeLog({
      ships: [ship(7, "reviewer"), ship(8, "owner", 3)],
      gateRows: [gate(7, "shadow"), gate(7, "live", "Orbit/Relay"), gate(9, "shadow")],
      consoleRows: [byRec({ subject: { source: "deposit", id: "dep-1" }, mode: "live" })],
      dayOf,
    });

    expect(rows.map((row) => [row.key, row.kind, row.approval])).toEqual([
      ["orbit/relay#7", "ship", "auto-by-rec"],
      ["deposit:dep-1", "decision", "auto-by-rec"],
      ["orbit/relay#9", "decision", "shadow"],
      ["orbit/relay#8", "ship", "owner"],
    ]);
  });

  it("labels a ship by-rec only shadowed with its real approval and a shadow tag", () => {
    const [row] = mergeLog({ ships: [ship(7, "reviewer")], gateRows: [gate(7, "shadow")], consoleRows: [], dayOf });

    expect(row).toMatchObject({ approval: "reviewer", shadow: true, recommendation: { answer: "merge" }, reverse: { kind: "revert" } });
  });

  it("shows a subject logged in both modes once, as its live row", () => {
    const rows = mergeLog({ ships: [], gateRows: [], consoleRows: [byRec({ subject: { source: "round", id: "r#q" }, mode: "shadow" }), byRec({ subject: { source: "round", id: "r#q" }, mode: "live" })], dayOf });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approval: "auto-by-rec", shadow: true, reverse: { kind: "overrule", source: "round", id: "r#q" } });
  });

  it("leaves skipped rows out and gives a shadow decision nothing to reverse", () => {
    const rows = mergeLog({ ships: [], gateRows: [], consoleRows: [byRec({ subject: { source: "deposit", id: "a" }, mode: "live", result: "skipped" }), byRec({ subject: { source: "deposit", id: "b" }, mode: "shadow" })], dayOf });

    expect(rows.map((row) => [row.key, row.reverse.kind])).toEqual([["deposit:b", "none"]]);
  });

  it("marks a D2 gate's row visual so its frames slot shows", () => {
    const [row] = mergeLog({ ships: [ship(7, "reviewer")], gateRows: [byRec({ facts: { repo: "orbit/relay", pr: 7, decisionClass: "D2" }, mode: "live" })], consoleRows: [], dayOf });

    expect(row).toMatchObject({ visual: true, frames: null });
  });

  it("shows an overruled decision with both picks and no second overrule", () => {
    const subject = { source: "deposit" as const, id: "dep-2" };
    const overrule = { answer: "teal", by: { class: "owner-remote" as const, id: "example-console", channel: "console:log" } };
    const rows = mergeLog({ ships: [], gateRows: [], consoleRows: [byRec({ subject, mode: "live" }), byRec({ subject, mode: "live", result: "overruled", resolvedAt: new Date(NOW - HOUR).toISOString(), overrule })], dayOf });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "deposit:dep-2", overruled: { from: "merge", to: "teal" }, reverse: { kind: "none", reason: "you overruled it" } });
  });

  it("gives a live gate decision its PR's revert link, never an overrule", () => {
    const [row] = mergeLog({ ships: [], gateRows: [gate(9, "live")], consoleRows: [], dayOf });

    expect(row?.reverse).toEqual({ kind: "revert", href: "https://github.com/orbit/relay/pull/9" });
  });

  it("counts the digest line by approval", () => {
    const rows = mergeLog({ ships: [ship(7, "reviewer"), ship(8, "owner")], gateRows: [gate(7, "shadow")], consoleRows: [byRec({ subject: { source: "deposit", id: "d" }, mode: "live" })], dayOf });

    expect(digestLine(logCounts(rows))).toBe("Decisions and ships: 2 shipped (1 by you, 1 by reviewer, 0 by plan approval, 0 by rec), 1 decided by rec, 1 shadow would-have.");
  });
});

describe("a merged PR's approval", () => {
  it("reads an owner tap on the approve-merge gate", () => {
    expect(approvalOf([{ kind: "gate", stepId: "approve-merge", status: "resolved", resolvedBy: "owner:console" }])).toEqual({ approval: "owner" });
  });

  it("reads a reviewer release by its rule", () => {
    expect(approvalOf([{ kind: "decision", rule: "MRG-AU-RV", stepId: "s", head: "h", reviewer: "r", profile: "p" }])).toEqual({ approval: "reviewer", rule: "MRG-AU-RV" });
  });

  it("never claims an owner tap the timeline does not hold", () => {
    expect(approvalOf([{ kind: "gate", stepId: "approve-merge", status: "cancelled", resolvedBy: null }, { kind: "wake" }])).toEqual({ approval: "unrecorded" });
  });
});
