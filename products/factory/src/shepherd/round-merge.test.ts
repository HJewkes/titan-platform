import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { PendingGate } from "../host.js";
import { RoundFeedbackSchema, roundMergeDecisions, shipAtHead, type RoundFeedback } from "./round-merge.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "round-merge");
const roundBytes = readFileSync(join(dir, "round.json"));
const gates = JSON.parse(readFileSync(join(dir, "pending-gates.json"), "utf8")) as PendingGate[];
const runs = JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")) as WorkflowRun[];

const H1 = "a1".repeat(20);
const H2 = "b2".repeat(20);
const NOW = new Date("2026-10-06T11:00:00.000Z");

function feedbackWith(answers: RoundFeedback["answers"], overrides: Partial<RoundFeedback> = {}): RoundFeedback {
  return {
    unit: "example-unit",
    round: 1,
    manifestSha256: createHash("sha256").update(roundBytes).digest("hex"),
    submittedAt: "2026-10-06T10:30:00.000Z",
    answers,
    ...overrides,
  };
}

const ship = (questionId: string) => ({ questionId, pick: "Ship it" });
const allShipped = [ship("tb-ship"), ship("tb-icon"), ship("tb-extra"), ship("tb-moved"), ship("tb-conflict"), ship("tb-nogate")];

function decisionFor(pr: number, feedback: RoundFeedback) {
  const result = roundMergeDecisions(roundBytes, feedback, gates, runs, NOW);
  return result.decisions.find((decision) => decision.pr === pr);
}

describe("roundMergeDecisions", () => {
  it("a ship pick at the gate's head resolves it with the bound head", () => {
    expect(decisionFor(101, feedbackWith(allShipped))).toMatchObject({
      kind: "resolve",
      runId: "run-101",
      stepId: "approve-merge",
      payload: { decision: "merge", headSha: H1 },
    });
  });

  it("answers an authority MRG-AU gate as well as a seat gate", () => {
    expect(decisionFor(102, feedbackWith(allShipped))).toMatchObject({ kind: "resolve", runId: "run-102", payload: { headSha: H2 } });
  });

  it("a Revise pick leaves the gate pending with the question id", () => {
    const answers = allShipped.map((a) => (a.questionId === "tb-ship" ? { questionId: "tb-ship", pick: "Revise" } : a));
    expect(decisionFor(101, feedbackWith(answers))).toMatchObject({ kind: "pending", reason: expect.stringContaining("tb-ship") });
  });

  it("a revision request leaves the gate pending even when it carries a ship pick", () => {
    const answers = allShipped.map((a) => (a.questionId === "tb-ship" ? { ...a, revisionRequested: true } : a));
    expect(decisionFor(101, feedbackWith(answers))).toMatchObject({ kind: "pending" });
  });

  it("a non-ship pick on a second bound question leaves the gate pending", () => {
    const answers = allShipped.map((a) => (a.questionId === "tb-extra" ? { questionId: "tb-extra", pick: "Revise" } : a));
    expect(decisionFor(102, feedbackWith(answers))).toMatchObject({ kind: "pending", reason: expect.stringContaining("tb-extra") });
  });

  it("a gate at a moved head stays pending naming both heads", () => {
    const decision = decisionFor(103, feedbackWith(allShipped));
    expect(decision).toMatchObject({ kind: "pending" });
    expect(decision).toMatchObject({ reason: expect.stringContaining("c3".repeat(20)) });
    expect(decision).toMatchObject({ reason: expect.stringContaining("d4".repeat(20)) });
  });

  it("a ship answer for a PR the round did not bind resolves nothing", () => {
    const result = roundMergeDecisions(roundBytes, feedbackWith([...allShipped, ship("tb-unbound")]), gates, runs, NOW);
    expect(result.decisions.map((d) => d.pr)).not.toContain(106);
  });

  it("a pending gate for a PR the round did not render stays pending", () => {
    const result = roundMergeDecisions(roundBytes, feedbackWith(allShipped), gates, runs, NOW);
    expect(result.decisions.filter((d) => d.kind === "resolve").map((d) => d.pr)).toEqual([101, 102]);
  });

  it("a partial submit leaving a bound question unanswered resolves nothing for that PR", () => {
    const answers = allShipped.filter((a) => a.questionId !== "tb-extra");
    expect(decisionFor(102, feedbackWith(answers))).toMatchObject({ kind: "pending", reason: expect.stringContaining("tb-extra") });
  });

  it("a feedback whose manifest hash differs from round.json resolves nothing", () => {
    const result = roundMergeDecisions(roundBytes, feedbackWith(allShipped, { manifestSha256: "0".repeat(64) }), gates, runs, NOW);
    expect(result).toMatchObject({ refused: expect.stringContaining("manifest hash"), decisions: [] });
  });

  it("a feedback for another unit or round resolves nothing", () => {
    expect(roundMergeDecisions(roundBytes, feedbackWith(allShipped, { round: 2 }), gates, runs, NOW).decisions).toEqual([]);
    expect(roundMergeDecisions(roundBytes, feedbackWith(allShipped, { unit: "other-unit" }), gates, runs, NOW).decisions).toEqual([]);
  });

  it("a stale submit resolves nothing", () => {
    const stale = feedbackWith(allShipped, { submittedAt: "2026-10-06T08:59:00.000Z" });
    expect(roundMergeDecisions(roundBytes, stale, gates, runs, NOW)).toMatchObject({ refused: expect.stringContaining("stale"), decisions: [] });
  });

  it("a conflict or escalation gate is never answered", () => {
    expect(decisionFor(104, feedbackWith(allShipped))).toMatchObject({ kind: "pending", reason: expect.stringContaining("shepherd-route/conflict") });
  });

  it("a bound PR with no pending gate reports no-gate", () => {
    expect(decisionFor(105, feedbackWith(allShipped))).toMatchObject({ kind: "no-gate" });
  });

  it("a round.json that is not a round resolves nothing", () => {
    expect(roundMergeDecisions("not json", feedbackWith(allShipped), gates, runs, NOW)).toMatchObject({ decisions: [] });
  });
});

describe("shipAtHead", () => {
  const REPO = "example-org/example-repo";
  const at = (pr: number, headSha: string) => ({ repo: REPO, pr, headSha });

  it("a Ship on every question bound to the PR at its current head is the approval, naming those questions", () => {
    expect(shipAtHead(roundBytes, feedbackWith(allShipped), at(102, H2), NOW)).toEqual({
      shipped: true,
      unit: "example-unit",
      round: 1,
      questionIds: ["tb-icon", "tb-extra"],
      submittedAt: "2026-10-06T10:30:00.000Z",
    });
  });

  it("a Ship at an older head never counts, naming both heads", () => {
    const result = shipAtHead(roundBytes, feedbackWith(allShipped), at(101, H2), NOW);
    expect(result).toMatchObject({ shipped: false, reason: expect.stringContaining(H1) });
    expect(result).toMatchObject({ reason: expect.stringContaining(H2) });
  });

  it("no Ship pick on a bound question is no approval", () => {
    const answers = allShipped.map((a) => (a.questionId === "tb-extra" ? { questionId: "tb-extra", pick: "Revise" } : a));
    expect(shipAtHead(roundBytes, feedbackWith(answers), at(102, H2), NOW)).toMatchObject({ shipped: false, reason: expect.stringContaining("tb-extra") });
  });

  it("an unanswered bound question is no approval", () => {
    const answers = allShipped.filter((a) => a.questionId !== "tb-icon");
    expect(shipAtHead(roundBytes, feedbackWith(answers), at(102, H2), NOW)).toMatchObject({ shipped: false, reason: expect.stringContaining("tb-icon") });
  });

  it("a revision request blocks the Ship even beside a ship pick", () => {
    const answers = allShipped.map((a) => (a.questionId === "tb-ship" ? { ...a, revisionRequested: true } : a));
    expect(shipAtHead(roundBytes, feedbackWith(answers), at(101, H1), NOW)).toMatchObject({ shipped: false });
  });

  it("a Ship stands for 24 hours, not the 2 hour gate-answer window", () => {
    expect(shipAtHead(roundBytes, feedbackWith(allShipped, { submittedAt: "2026-10-05T12:00:00.000Z" }), at(101, H1), NOW)).toMatchObject({ shipped: true });
    expect(shipAtHead(roundBytes, feedbackWith(allShipped, { submittedAt: "2026-10-05T10:00:00.000Z" }), at(101, H1), NOW)).toMatchObject({
      shipped: false,
      reason: expect.stringContaining("stale"),
    });
  });

  it("a submit stamped in the future is not believed", () => {
    const future = feedbackWith(allShipped, { submittedAt: "2026-10-07T11:00:00.000Z" });
    expect(shipAtHead(roundBytes, future, at(101, H1), NOW)).toMatchObject({ shipped: false, reason: expect.stringContaining("future") });
  });

  it("a feedback whose manifest hash differs from round.json is no approval", () => {
    const forged = feedbackWith(allShipped, { manifestSha256: "0".repeat(64) });
    expect(shipAtHead(roundBytes, forged, at(101, H1), NOW)).toMatchObject({ shipped: false, reason: expect.stringContaining("manifest hash") });
  });

  it("a round that binds no question to the PR is no approval", () => {
    expect(shipAtHead(roundBytes, feedbackWith(allShipped), at(999, H1), NOW)).toMatchObject({ shipped: false, reason: expect.stringContaining("no question binds") });
    expect(shipAtHead(roundBytes, feedbackWith(allShipped), { repo: "other-org/other", pr: 101, headSha: H1 }, NOW)).toMatchObject({ shipped: false });
  });

  it("a round.json that is not a round is no approval", () => {
    expect(shipAtHead("not json", feedbackWith(allShipped), at(101, H1), NOW)).toMatchObject({ shipped: false });
  });
});

describe("RoundFeedbackSchema", () => {
  it("reads the decision fields of a feedback.json and drops the rest", () => {
    const answer = { questionId: "tb-ship", pick: "Ship it", note: "lgtm" };
    const raw: unknown = { ...feedbackWith([answer]), reviewer: "owner" };
    expect(RoundFeedbackSchema.parse(raw)).toEqual(feedbackWith([{ questionId: "tb-ship", pick: "Ship it" }]));
  });

  it("rejects a feedback with no answers list", () => {
    expect(RoundFeedbackSchema.safeParse({ unit: "u", round: 1, manifestSha256: "x", submittedAt: "t" }).success).toBe(false);
  });
});
