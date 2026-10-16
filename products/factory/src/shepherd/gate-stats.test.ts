import type { GateRecord } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { gateStats, policyRow, visualGateStats } from "./gate-stats.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const WEEK = 7 * 24 * 60;
const iso = (at: number): string => new Date(at).toISOString();
const SEAT_PROMPT = "Merge acme/widgets#3? Policy shepherd-seat/design-coord+voltras-coord: the seat's PRs need the owner";

let serial = 0;

function gate(step: string, prompt: string, opened: number, extra: Partial<GateRecord> = {}): GateRecord {
  serial += 1;
  return { id: `run-${serial}/${step}:0`, prompt, schema: undefined, status: "pending", payload: undefined, reason: undefined, createdAt: iso(opened), resolvedAt: undefined, expiresAt: undefined, resolvedBy: undefined, resolvedEvidence: undefined, rule: undefined, summary: undefined, evidenceRef: undefined, questions: undefined, ...extra };
}

function answered(step: string, prompt: string, opened: number, hours: number, cls: "owner-terminal" | "coordinator", decision: string, evidence?: GateRecord["resolvedEvidence"]): GateRecord {
  return gate(step, prompt, opened, { status: "resolved", resolvedAt: iso(opened + hours * HOUR), payload: { decision }, resolvedBy: { class: cls, id: "x", channel: "factory-cli" }, resolvedEvidence: evidence });
}

const cancelled = (opened: number, hours: number): GateRecord => gate("approve-merge", SEAT_PROMPT, opened, { status: "cancelled", reason: "head moved", resolvedAt: iso(opened + hours * HOUR) });
const delegateEvidence = { kind: "delegate", gateId: "g", delegate: "tp-operator", grant: "item 193", readAt: iso(NOW) };

describe("gateStats", () => {
  it("meters each policy row by resolver bucket with decisions, unanswered gates and waits", () => {
    const opened = NOW - 2 * DAY;
    const gates = [
      answered("approve-merge", SEAT_PROMPT, opened, 1, "owner-terminal", "merge"),
      answered("approve-merge", SEAT_PROMPT, opened, 2, "owner-terminal", "merge"),
      answered("approve-merge", SEAT_PROMPT, opened, 4, "owner-terminal", "abandon"),
      answered("approve-merge", SEAT_PROMPT, opened, 0.5, "coordinator", "merge", delegateEvidence),
      cancelled(opened, 3),
      cancelled(opened, 5),
      cancelled(opened, 6),
      gate("approve-merge", SEAT_PROMPT, NOW - 10 * HOUR),
      answered("stuck-behind", "p", opened, 0.25, "coordinator", "retry"),
      answered("stuck-behind", "p", opened, 0.75, "coordinator", "retry"),
    ];

    const rows = gateStats(gates, NOW, WEEK);

    expect(rows).toEqual([
      { policyRow: "shepherd-seat/design-coord+voltras-coord", resolver: "delegate", count: 1, decisions: { merge: 1 }, cancelledUnanswered: 0, pending: 0, medianHours: 0.5, maxHours: 0.5 },
      { policyRow: "shepherd-seat/design-coord+voltras-coord", resolver: "owner-terminal", count: 3, decisions: { merge: 2, abandon: 1 }, cancelledUnanswered: 0, pending: 0, medianHours: 2, maxHours: 4 },
      { policyRow: "shepherd-seat/design-coord+voltras-coord", resolver: "unanswered", count: 4, decisions: {}, cancelledUnanswered: 3, pending: 1, medianHours: 5.5, maxHours: 10 },
      { policyRow: "step/stuck-behind", resolver: "coordinator", count: 2, decisions: { retry: 2 }, cancelledUnanswered: 0, pending: 0, medianHours: 0.5, maxHours: 0.75 },
    ]);
  });

  it("reads a row name holding + whole", () => {
    expect(policyRow(gate("approve-merge", SEAT_PROMPT, NOW))).toBe("shepherd-seat/design-coord+voltras-coord");
  });

  it("windows on when the gate opened, not when it was answered", () => {
    const gates = [answered("approve-merge", SEAT_PROMPT, NOW - 8 * DAY, 6 * 24, "owner-terminal", "merge"), answered("approve-merge", SEAT_PROMPT, NOW - 6 * DAY, 1, "owner-terminal", "abandon")];

    const rows = gateStats(gates, NOW, WEEK);

    expect(rows.map((row) => row.decisions)).toEqual([{ abandon: 1 }]);
  });

  it("counts a pending gate's wait to now", () => {
    const rows = gateStats([gate("ci-failed", "p", NOW - 30 * HOUR)], NOW, WEEK);

    expect(rows).toEqual([{ policyRow: "step/ci-failed", resolver: "unanswered", count: 1, decisions: {}, cancelledUnanswered: 0, pending: 1, medianHours: 30, maxHours: 30 }]);
  });

  it("reads a boolean approve as approve or decline", () => {
    const rows = gateStats([gate("main-red", "p", NOW - HOUR, { status: "resolved", resolvedAt: iso(NOW), payload: { approve: false }, resolvedBy: { class: "owner-remote", id: "x", channel: "slack" } })], NOW, WEEK);

    expect(rows[0]).toMatchObject({ resolver: "owner-remote", decisions: { decline: 1 } });
  });
});

describe("visualGateStats", () => {
  const head = "a".repeat(40);
  const visualPrompt = (pr: number, rule = "visual-path"): string => `Merge PR #${pr} in acme/widgets at head ${head}? CI is green. Policy shepherd-merge-guard/${rule}: the pull request changes visual paths`;
  const visual = (pr: number, opened: number, hours?: number, rule?: string): GateRecord => {
    const schema = { type: "object", properties: { headSha: { const: head } } } as GateRecord["schema"];
    const base = hours === undefined ? gate("approve-merge", visualPrompt(pr, rule), opened) : answered("approve-merge", visualPrompt(pr, rule), opened, hours, "owner-terminal", "merge");
    return { ...base, schema };
  };

  it("takes the latency median over a PR's two resolved visual gates and counts one re-ask", () => {
    const opened = NOW - DAY;

    const stats = visualGateStats([visual(7, opened, 1), visual(7, opened, 3)], NOW, WEEK);

    expect(stats).toEqual({ count: 2, open: 0, resolved: 2, medianHours: 2, p90Hours: 3, reAsks: 1, prsWithReAsk: 1 });
  });

  it("leaves a non-visual approve-merge gate out", () => {
    const stats = visualGateStats([visual(7, NOW - DAY, 1, "ci-policy-weakened"), visual(8, NOW - DAY, 1)], NOW, WEEK);

    expect(stats).toMatchObject({ count: 1, reAsks: 0, prsWithReAsk: 0 });
  });

  it("counts an unresolved visual gate as open, with no latency of zero", () => {
    const stats = visualGateStats([visual(7, NOW - HOUR)], NOW, WEEK);

    expect(stats).toEqual({ count: 1, open: 1, resolved: 0, medianHours: null, p90Hours: null, reAsks: 0, prsWithReAsk: 0 });
  });

  it("windows on when the gate opened", () => {
    expect(visualGateStats([visual(7, NOW - 8 * DAY, 1)], NOW, WEEK).count).toBe(0);
  });
});
