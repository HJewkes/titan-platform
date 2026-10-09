import { describe, expect, it } from "vitest";
import { formatShepherd } from "./format.js";
import { WaitingSchema, waitingGates } from "./waiting.js";
import type { WatchRow } from "./view.js";

const NOW = new Date("2026-01-10T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(NOW.getTime() - hours * HOUR).toISOString();

function row(n: number, stepId: string, hoursAgo: number, extra: Partial<WatchRow> = {}): WatchRow {
  return {
    repo: "acme/widgets",
    pr: n,
    branch: `feat/${n}`,
    runId: `run-${n}`,
    task: `demo/T-${n}`,
    phase: "awaiting-approval",
    headSha: `${n}`.repeat(40).slice(0, 40),
    phaseSince: ago(hoursAgo),
    nextAction: `owner: resolve ${stepId}`,
    pendingGate: { gateId: `run-${n}/${stepId}`, stepId, since: ago(hoursAgo) },
    held: null,
    stalled: null,
    outcome: null,
    ...extra,
  };
}

const FIXTURE = [
  row(1, "ci-failed", 30),
  row(2, "approve-merge", 5),
  row(3, "approve-merge:2", 45),
  row(4, "sh-sent-back", 2),
  row(5, "stuck-behind", 8),
  row(6, "release", 12, { held: { reason: "wait for the owner" } }),
  row(7, "one-way", 1),
  row(8, "failed-rounds", 20),
  { ...row(9, "approve-merge", 1), pendingGate: null },
];

describe("waitingGates", () => {
  it("lists the gates the owner answers oldest first and the seat's work apart", () => {
    const { owner, seat } = waitingGates(FIXTURE, NOW);

    expect(owner.map((g) => g.gateId)).toEqual(["run-3/approve-merge:2", "run-8/failed-rounds", "run-6/release", "run-2/approve-merge", "run-7/one-way"]);
    expect(seat.map((g) => g.gateId)).toEqual(["run-1/ci-failed", "run-5/stuck-behind", "run-4/sh-sent-back"]);
  });

  it("names the PR, head, task, age in hours and held reason of each gate", () => {
    const [first, , third] = waitingGates(FIXTURE, NOW).owner;

    expect(first).toEqual({ gateId: "run-3/approve-merge:2", stepId: "approve-merge", repo: "acme/widgets", pr: 3, head: "3".repeat(40), task: "demo/T-3", since: ago(45), ageHours: 45, held: null });
    expect(third).toMatchObject({ stepId: "release", ageHours: 12, held: "wait for the owner" });
  });

  it("puts a gate kind it does not know on the owner's side", () => {
    const { owner, seat } = waitingGates([row(1, "something-new", 3)], NOW);

    expect(owner).toHaveLength(1);
    expect(seat).toEqual([]);
  });

  it("prints a shape the schema accepts", () => {
    expect(WaitingSchema.parse(JSON.parse(JSON.stringify(waitingGates(FIXTURE, NOW))))).toEqual(waitingGates(FIXTURE, NOW));
  });

  it("prints the owner's gates first, each with its age, head and held reason", () => {
    const text = formatShepherd("shepherd.waiting", waitingGates(FIXTURE, NOW));

    expect(text.split("\n").slice(0, 3)).toEqual([
      "waiting on the owner (5), oldest first:",
      `  45h  run-3/approve-merge:2  acme/widgets#3 3333333  demo/T-3`,
      `  20h  run-8/failed-rounds  acme/widgets#8 8888888  demo/T-8`,
    ]);
    expect(text).toContain("[held: wait for the owner]");
    expect(text).toContain("seat work (3), oldest first:");
  });
});
