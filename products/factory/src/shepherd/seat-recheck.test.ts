import { fakeSha } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { SeatHeld } from "./phases.js";
import { MERGE_ON_GREEN_GRANT } from "./policy.js";
import { reviewPhase } from "./review.js";
import { recordsRecheck } from "./seat-recheck.js";
import { asksOwnerBrief, recheckSeat } from "./take-verdict.js";

/** Synthetic stand-in for a head whose own MERGE a seat WAIT held last round. */
const HEAD = fakeSha("seat-recheck-head");
const REVIEWER = { agentId: "agent-rv-octo-demo-1", sessionId: "session-rv-octo-demo-1" };
const LOCATOR = { source: { conversation: { nativeId: REVIEWER.sessionId } } };
const MERGE = { kind: "verdict", verdict: "MERGE", head: HEAD, locator: LOCATOR, reviewer: REVIEWER };
const HELD: SeatHeld = { head: HEAD, locator: LOCATOR, reviewer: REVIEWER, dispatchedReviewer: REVIEWER, merge: MERGE };
const AUTO = JSON.stringify({ merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" });

interface Recorded {
  /** The step the run's recorded history names next, or undefined for a run past its history. */
  next: string | undefined;
  /** What the fix-proof read answers; a skipped proof is neither a NO_REPRO nor unverified. */
  proof?: object;
  /** What the seat recheck answers. */
  recheck?: object;
}

/** A context replaying `recorded`; each step answers by its id prefix and logs its id and input. */
function replaying(recorded: Recorded): { ctx: WorkflowContext; dispatched: string[]; inputs: Map<string, unknown> } {
  const dispatched: string[] = [];
  const inputs = new Map<string, unknown>();
  const unused = (): never => {
    throw new Error("not used here");
  };
  const answers: Record<string, unknown> = {
    "sh-fix-proof": recorded.proof ?? { kind: "skipped", reason: "no fix-proof check on this repo" },
    "sh-review-intent": { kind: "none", reason: "recorded before the recheck existed" },
    "sh-seat-recheck": recorded.recheck ?? { kind: "none", reason: "seat check: the seat said WAIT", seatHeld: MERGE },
    "sh-publish-review": { headSha: HEAD, conclusion: "success", published: false, reason: "no App" },
  };
  const ctx: WorkflowContext = {
    runId: "run-1",
    workflowName: "shepherd-pr",
    signal: new AbortController().signal,
    param: (name) => (name === "policy" ? AUTO : undefined),
    iteration: () => 0,
    historyNext: () => recorded.next,
    resumedGate: () => undefined,
    expireGates: () => [],
    dispatch: async (stepId, _template, options) => {
      dispatched.push(stepId);
      const input: unknown = JSON.parse(Object.values(options?.vars ?? {})[0] ?? "null");
      inputs.set(stepId, input);
      const prefix = stepId.slice(0, stepId.indexOf(":"));
      if (!(prefix in answers)) throw new Error(`stop at ${stepId}`);
      return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-12T00:00:00.000Z", data: options?.schema?.parse({ result: answers[prefix] }) };
    },
    seed: unused,
    assisted: unused,
    authorize: unused,
  };
  return { ctx, dispatched, inputs };
}

const request = { repo: "octo/demo", pr: 1, round: 1, headSha: HEAD, seatHeld: HELD };

describe("recordsRecheck", () => {
  it.each([
    ["a run past its recorded history", undefined, true],
    ["a replay that recorded the recheck here", `sh-seat-recheck:${HEAD}`, true],
    ["a replay that recorded a fresh review here, before the recheck existed", `sh-review-intent:${HEAD}`, false],
    ["a replay that recorded a recheck at another head", `sh-seat-recheck:${fakeSha("other-head")}`, false],
  ])("is %s: %s", (_name, next, expected) => {
    expect(recordsRecheck(replaying({ next }).ctx, HEAD)).toBe(expected);
  });
});

describe("the review of a head whose own MERGE a seat held, on replay", () => {
  it("takes a fresh review, as recorded, when the old history reviewed the held head again", async () => {
    const { ctx, dispatched } = replaying({ next: `sh-review-intent:${HEAD}` });

    const verdict = await reviewPhase(ctx, request);

    expect(dispatched).toEqual([`sh-fix-proof:${HEAD}`, `sh-review-intent:${HEAD}`]);
    expect(verdict).toEqual({ kind: "none", cause: "no-verdict" });
  });

  it("re-checks only the seat on a run past its history, starting no review", async () => {
    const { ctx, dispatched } = replaying({ next: undefined });

    const verdict = await reviewPhase(ctx, request);

    expect(dispatched).toEqual([`sh-fix-proof:${HEAD}`, `sh-seat-recheck:${HEAD}`]);
    expect(verdict).toMatchObject({ kind: "none", cause: "external-hold", seatHeld: { head: HEAD } });
  });

  it("keeps the merge-on-green grant for a rechecked MERGE at a head whose fix-proof is unverified, and records the standing", async () => {
    const verified = replaying({ next: undefined, recheck: MERGE });
    const unverified = replaying({ next: undefined, recheck: MERGE, proof: { kind: "error", reason: "the fix-proof check could not be read" } });

    await expect(reviewPhase(verified.ctx, request)).rejects.toThrow(`stop at sh-merge-evidence:${HEAD}`);
    await expect(reviewPhase(unverified.ctx, request)).rejects.toThrow(`stop at sh-merge-evidence:${HEAD}`);

    expect(verified.inputs.get(`sh-merge-evidence:${HEAD}`)).toMatchObject({ seatGrants: [MERGE_ON_GREEN_GRANT] });
    expect(verified.inputs.get(`sh-merge-evidence:${HEAD}`)).not.toHaveProperty("proofUnverified");
    expect(unverified.inputs.get(`sh-merge-evidence:${HEAD}`)).toMatchObject({ seatGrants: [MERGE_ON_GREEN_GRANT], proofUnverified: "unread (the fix-proof check could not be read)" });
    expect(unverified.inputs.get(`sh-merge-evidence:${HEAD}`)).not.toHaveProperty("grantWithheld");
  });

  it("cannot re-check a seat without the round's fix-proof standing, since an empty one reads as verified", () => {
    const omitted = (ctx: WorkflowContext, target: Parameters<typeof recheckSeat>[1], held: SeatHeld) =>
      // @ts-expect-error recheckSeat takes the round's fix-proof standing; no default may stand in for it
      recheckSeat(ctx, target, held);

    expect(typeof omitted).toBe("function");
  });
});

describe("whether a round asks its reviewer for an owner brief", () => {
  it("asks for none under an auto policy, since an unverified fix-proof no longer reaches the owner (decision 303)", () => {
    const { ctx } = replaying({ next: undefined });

    expect(asksOwnerBrief(ctx)).toBe(false);
  });
});
