import { fakeSha } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { step } from "../workflows/land.js";
import { onEscalated, tappedReview, type FailedRoundsRun } from "./failed-rounds-demotion.js";
import { LeaveLand } from "./leave-land.js";
import { freshNoVerdictState } from "./no-verdict-round.js";
import type { ObservedPr } from "./observe.js";
import type { Escalated } from "./route-table.js";
import { countRound, type Routed } from "./routed.js";

const REPO = "octo/demo";
const HEAD = fakeSha("repeat-head");
const NEXT = fakeSha("repeat-next");

const StepInput = z.record(z.string(), z.unknown());
const Recorded = z.looseObject({});

interface RecordingRun {
  ctx: WorkflowContext;
  steps: string[];
}

/** Every code step answers with its own input, so a round's steps record the results the test hands them. */
function recordingCtx(historyNext: () => string | undefined): RecordingRun {
  const steps: string[] = [];
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const input = StepInput.parse(JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}"));
    steps.push(stepId);
    const result = stepId.startsWith("sh-no-verdict-diagnosis") ? { spawned: true, agent: "diag-1" } : stepId.startsWith("await-new-head") ? { headSha: NEXT, state: "open" } : { ...input, commentId: 7 };
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result }) };
  }
  return { ctx: partialFake<WorkflowContext>({ runId: "run-1", param: () => undefined, historyNext, dispatch }), steps };
}

type Counted = FailedRoundsRun & RecordingRun & Parameters<typeof countRound>[0];

function panelRun(historyNext: () => string | undefined = () => undefined): Counted {
  return {
    ...recordingCtx(historyNext),
    ...{ target: { repo: REPO, pr: 1 }, task: "demo/T-1", state: { waits: 0 }, reviews: new Map(), fresh: new Set<string>(), escalations: new Map() },
    ...{ failedRounds: 0, failedOutcomes: [], fallbackReviewed: false, ...freshNoVerdictState() },
    ...{ throttledRounds: 1, closer: { streak: 0 }, seatHeldRounds: new Map(), fixFirstTrail: [] },
  };
}

const noVerdictRound: Routed = { headSha: HEAD, verdict: { kind: "none", cause: "no-verdict", reason: "a blocking panel member gave no verdict" }, observed: partialFake<ObservedPr>(), outcome: "no-verdict", route: "fresh-reviewer" };

/** How one panel member's round went: it said MERGE, gave nothing, never started, or waited out its deadline. */
type Member = "merge" | "silent" | "refused" | "ran-out";

const DISPATCH: Record<Member, object> = {
  merge: { kind: "dispatched", at: 1, agentId: "agent", sessionId: "session" },
  silent: { kind: "dispatched", at: 1, agentId: "agent", sessionId: "session" },
  "ran-out": { kind: "dispatched", at: 1, agentId: "agent", sessionId: "session" },
  refused: { kind: "none", reason: "the reviewer dispatch was refused: DispatchError", refused: "DispatchError" },
};
const AWAITED: Record<Member, object | undefined> = { merge: { kind: "verdict", verdict: "MERGE", head: HEAD }, silent: { kind: "none" }, "ran-out": { kind: "none", ended: "deadline" }, refused: undefined };

/** One recorded panel review of correctness and adversary at the head, then the round counted as `noVerdictRound`. */
async function panelRound(run: Counted, members: { correctness: Member; adversary: Member }): Promise<Escalated | undefined> {
  const ctx = tappedReview(run);
  await step(ctx, `sh-review-intent:${HEAD}`, { kind: "intent", reviewer: "rv-demo", panelReviewers: { adversary: "rv-demo-adversary" } }, Recorded);
  await step(ctx, `sh-review:${HEAD}:adversary`, DISPATCH[members.adversary], Recorded);
  await step(ctx, `sh-review:${HEAD}`, DISPATCH[members.correctness], Recorded);
  for (const [suffix, member] of [["", members.correctness], [":adversary", members.adversary]] as const) {
    const awaited = AWAITED[member];
    if (awaited !== undefined) await step(ctx, `sh-await-verdict:${HEAD}${suffix}`, awaited, Recorded);
  }
  await step(ctx, `sh-review-panel:${HEAD}`, { outcome: "no-verdict", head: HEAD, findings: [], dissent: [], degraded: [], satisfiesG10: false }, Recorded);
  return countRound(run, noVerdictRound);
}

const BOTH_MERGE = { correctness: "merge", adversary: "merge" } as const;

/** Round 1 and round 2 at the same head; what round 2 came to, as `repeated` or `retry`. */
async function secondRound(first: { correctness: Member; adversary: Member }, second: { correctness: Member; adversary: Member }): Promise<string> {
  const run = panelRun();
  await panelRound(run, first);
  const escalated = await panelRound(run, second);
  return escalated?.repeatedNoVerdict === true ? "repeated" : (escalated?.escalation ?? "retry");
}

describe("a no-verdict panel round that repeats the last one at the same head goes to the diagnosis planner (TP-3910)", () => {
  it("routes tp#2145's round 2, both members MERGE behind the same unplanned missing seat, to the planner with no third review", async () => {
    const run = panelRun();
    expect(await panelRound(run, BOTH_MERGE)).toBeUndefined();

    const escalated = await panelRound(run, BOTH_MERGE);
    const left = await onEscalated(run, HEAD, escalated!).catch((error: unknown) => error);

    expect(escalated).toMatchObject({ escalation: "failed-rounds", repeatedNoVerdict: true });
    expect(left).toBeInstanceOf(LeaveLand);
    expect(run.steps.filter((id) => !id.startsWith("sh-review") && !id.startsWith("sh-await-verdict"))).toEqual([`sh-auto-pass:D7-no-verdict-diagnosis:${HEAD}`, `sh-no-verdict-diagnosis:${HEAD}`, "await-new-head:0"]);
    expect(run.steps.filter((id) => id === `sh-review:${HEAD}`)).toHaveLength(2);
    expect(run.fresh.has(HEAD)).toBe(false);
    expect(run.escalations.size).toBe(0);
  });

  it("still retries a repeated round where a member failed to start or timed out", async () => {
    const refused = { correctness: "merge", adversary: "refused" } as const;
    const ranOut = { correctness: "merge", adversary: "ran-out" } as const;

    const routes = [await secondRound(BOTH_MERGE, BOTH_MERGE), await secondRound(refused, refused), await secondRound(ranOut, ranOut), await secondRound(refused, BOTH_MERGE)];

    expect(routes).toEqual(["repeated", "retry", "retry", "retry"]);
  });

  it("retries a round 2 whose missing seats differ from round 1's once, then diagnoses round 3 that repeats it", async () => {
    const adversarySilent = { correctness: "merge", adversary: "silent" } as const;
    const run = panelRun();
    await panelRound(run, BOTH_MERGE);

    const second = await panelRound(run, adversarySilent);
    const third = await panelRound(run, adversarySilent);

    expect([await secondRound(adversarySilent, adversarySilent), await secondRound(BOTH_MERGE, adversarySilent)]).toEqual(["repeated", "retry"]);
    expect(second).toBeUndefined();
    expect(third).toMatchObject({ escalation: "failed-rounds", repeatedNoVerdict: true });
  });

  it("replays a run recorded before TP-3910 that reviewed the repeated head again, without diverging", async () => {
    let next: string | undefined = `sh-review-intent:${HEAD}`;
    const replayed = panelRun(() => next);
    await panelRound(replayed, BOTH_MERGE);
    const recordedRetry = await panelRound(replayed, BOTH_MERGE);
    next = `sh-auto-pass:D7-no-verdict-diagnosis:${HEAD}`;
    const recordedDiagnosis = panelRun(() => next);
    await panelRound(recordedDiagnosis, BOTH_MERGE);

    expect([recordedRetry, await panelRound(recordedDiagnosis, BOTH_MERGE)]).toEqual([undefined, expect.objectContaining({ repeatedNoVerdict: true })]);
  });
});
