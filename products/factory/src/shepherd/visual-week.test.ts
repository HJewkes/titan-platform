import { createHash } from "node:crypto";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { PendingGate } from "../host.js";
import { roundShips, type HeldAt, type StoredRound } from "./round-ship-sweep.js";
import { isoWeek, visualWeekBatch } from "./visual-week.js";

const REPO = "example-org/example-design";
const NOW = new Date("2026-11-04T09:00:00.000Z");
const headOf = (pr: number): string => String(pr % 10).repeat(40);
const notHeld: HeldAt = () => undefined;

/** A parked shepherd-pr run whose last merge decision gated `decidedHead` under merge-guard row `rowId`. */
function parked(pr: number, rowId = "visual-path", decidedHead = headOf(pr)): { gate: PendingGate; run: WorkflowRun } {
  const runId = `run-${pr}`;
  const prompt = `Merge PR #${pr} in ${REPO} at head ${headOf(pr)}? CI is green. Policy shepherd-merge-guard/${rowId}: the owner decides visual changes`;
  const output = JSON.stringify({ result: { outcome: "gate", headSha: decidedHead, rule: { table: "shepherd-merge-guard", rowId } } });
  const gate = { runId, stepId: "approve-merge", gate: { id: `${runId}/approve-merge`, prompt, status: "pending", payload: null, createdAt: "2026-11-02T10:00:00.000Z" } };
  const run = {
    id: runId,
    workflowName: "shepherd-pr",
    params: { repo: REPO, pr: String(pr) },
    status: "waiting",
    currentStep: "approve-merge",
    stepResults: { "merge-policy:0": { stepId: "merge-policy:0", iteration: 0, agentId: null, signal: null, completedAt: "2026-11-02T10:00:00.000Z", output } },
    activeSteps: {},
    revision: 3,
    ownerGeneration: 1,
    startedAt: "2026-11-02T09:00:00.000Z",
    completedAt: null,
    error: null,
  } as unknown as WorkflowRun;
  return { gate: gate as PendingGate, run };
}

const world = (...parts: ReturnType<typeof parked>[]) => ({ gates: parts.map((part) => part.gate), runs: parts.map((part) => part.run) });
const batchOf = (parts: ReturnType<typeof parked>[], heldAt: HeldAt = notHeld) => visualWeekBatch({ repo: REPO, ...world(...parts), heldAt, now: NOW });

describe("visualWeekBatch", () => {
  it("batches only pending visual-path gates at a current unheld head", () => {
    const held: HeldAt = (_repo, pr) => (pr === 3 ? "g10 review" : undefined);
    const batch = batchOf([parked(1), parked(2, "skill-path"), parked(3), parked(4, "visual-path", headOf(9))], held);
    expect(batch.questions.map((question) => question.merge.pr)).toEqual([1]);
    expect(batch.skipped).toEqual([
      { pr: 2, reason: expect.stringContaining("not a visual-path gate") },
      { pr: 3, reason: "held: g10 review" },
      { pr: 4, reason: expect.stringContaining("not a visual-path gate") },
    ]);
  });

  it("names the unit for the ISO week and binds each question to the gate's head with only Ship as a ship option", () => {
    const batch = batchOf([parked(1)]);
    expect(batch.unit).toBe("td-ship-week-2026-W45");
    expect(batch.questions[0]!.merge).toEqual({ repo: REPO, pr: 1, headSha: headOf(1), ship: ["Ship"] });
  });

  it("another repo's gates are left out of the batch", () => {
    const other = parked(1);
    other.gate.gate.prompt = other.gate.gate.prompt.replace(REPO, "example-org/other-repo");
    expect(batchOf([other]).questions).toEqual([]);
  });

  it("a batch round with Ship on two of three PRs resolves those two through roundShips", () => {
    const parts = [parked(1), parked(2), parked(3)];
    const batch = batchOf(parts);
    const round = Buffer.from(JSON.stringify(batch));
    const answers = [{ questionId: "pr-1", pick: "Ship" }, { questionId: "pr-2", pick: "Ship" }, { questionId: "pr-3", pick: "Don't ship" }];
    const feedback = Buffer.from(JSON.stringify({ unit: batch.unit, round: 1, manifestSha256: createHash("sha256").update(round).digest("hex"), submittedAt: "2026-11-04T08:30:00.000Z", answers }));
    const stored: StoredRound = { id: `${batch.unit}-r1`, round, feedback, builtAtMs: 0 };
    const ships = roundShips([stored], world(...parts).gates, world(...parts).runs, NOW, notHeld);
    expect(ships.filter((ship) => ship.kind === "resolve").map((ship) => ({ runId: ship.runId, headSha: ship.payload.headSha }))).toEqual([
      { runId: "run-1", headSha: headOf(1) },
      { runId: "run-2", headSha: headOf(2) },
    ]);
    expect(ships.find((ship) => ship.kind === "pending")).toMatchObject({ pr: `${REPO}#3` });
  });

  it("a moved head rolls to the next week", () => {
    const batch = batchOf([parked(1)]);
    const moved = parked(1);
    const newHead = "c".repeat(40);
    moved.gate.gate.prompt = moved.gate.gate.prompt.replace(headOf(1), newHead);
    moved.run.stepResults["merge-policy:0"]!.output = moved.run.stepResults["merge-policy:0"]!.output!.replace(headOf(1), newHead);
    const round = Buffer.from(JSON.stringify(batch));
    const feedback = Buffer.from(JSON.stringify({ unit: batch.unit, round: 1, manifestSha256: createHash("sha256").update(round).digest("hex"), submittedAt: "2026-11-04T08:30:00.000Z", answers: [{ questionId: "pr-1", pick: "Ship" }] }));
    const ships = roundShips([{ id: "r1", round, feedback, builtAtMs: 0 }], [moved.gate], [moved.run], NOW, notHeld);
    expect(ships).toEqual([expect.objectContaining({ kind: "pending", reason: expect.stringContaining("PR moved") })]);
    expect(batchOf([moved]).questions[0]!.merge.headSha).toBe(newHead);
  });
});

describe("isoWeek", () => {
  it("reads the year a late-December day belongs to", () => {
    expect(isoWeek(new Date("2026-12-31T12:00:00.000Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2027-01-01T12:00:00.000Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2027-01-04T00:00:00.000Z"))).toBe("2027-W01");
  });
});
