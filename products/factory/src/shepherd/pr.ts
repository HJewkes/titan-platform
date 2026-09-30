import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow, stepIdMatches, type StepDeclaration, type WorkflowDefinition } from "../definition.js";
import type { StepRoute } from "../routed-runner.js";
import { AWAIT_HEAD_STEPS, AwaitHeadResult } from "../workflows/await-head.js";
import { onCiFailed, type LandPrState } from "../workflows/land-pr.js";
import { CiSnapshotResult } from "../workflows/land-steps.js";
import { LAND_STEPS, codeRoute, land, step, type CiSnapshot, type LandOptions, type LandOutcome } from "../workflows/land.js";
import { PARK_STEPS, parkAtGreen, parkRoutes, type ParkPort } from "./park.js";
import type { ShepherdDeps, ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { EffectivePolicySchema, OWNER_GATE_POLICY, shepherdLandOptions, stricterPolicy, type EffectivePolicy } from "./policy.js";
import { POST_MERGE_STEPS, afterStages, type AfterStage, postMergeRoutes, shepherdMainCi } from "./post-merge.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes, type ReviewWiring } from "./review.js";
import { WAKE_STEPS, wakePhase, wakeRoutes } from "./wake.js";

export const SH_AWAIT_PR_POLL_MS = 30_000;

/** Steps shared with land-pr are declared here too; their routes are registered once, in `factoryRoutes`. */
export const SHEPHERD_STEPS: readonly StepDeclaration[] = [
  ...LAND_STEPS,
  ...AWAIT_HEAD_STEPS,
  { id: "rerun", kind: "dispatch" },
  { id: "ci-failed", kind: "assisted" },
  { id: "sh-await-pr", kind: "dispatch" },
  { id: "sh-landed", kind: "dispatch" },
  { id: "sh-policy", kind: "dispatch" },
  { id: "sh-sent-back", kind: "assisted" },
  ...WAKE_STEPS,
  ...PARK_STEPS,
  ...REVIEW_STEPS,
  ...POST_MERGE_STEPS,
];

export interface ShepherdPrParams {
  repo: RepoSlug;
  pr?: number;
  branch?: string;
  policy: EffectivePolicy;
  /** Parsed before land, so a malformed list fails the run before any merge. */
  after: AfterStage[];
}

/** A run with no `policy` param gets the owner gate as its ceiling; the registration's policy can only narrow it. */
export function shepherdPrParams(ctx: WorkflowContext): ShepherdPrParams {
  const repo = ctx.param("repo");
  const rawPr = ctx.param("pr");
  const branch = ctx.param("branch");
  if (!repo) throw new Error("shepherd-pr: param repo is required");
  const pr = rawPr === undefined ? undefined : Number(rawPr);
  if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) throw new Error(`shepherd-pr: param pr must be a positive integer, got ${rawPr}`);
  if (pr === undefined && !branch) throw new Error("shepherd-pr: param pr or branch is required");
  const rawPolicy = ctx.param("policy");
  const policy = rawPolicy === undefined ? OWNER_GATE_POLICY : EffectivePolicySchema.parse(JSON.parse(rawPolicy));
  return { repo, ...(pr === undefined ? { branch: branch! } : { pr }), policy, after: afterStages(ctx) };
}

interface PrTarget {
  repo: RepoSlug;
  pr: number;
}

interface ShepherdRun {
  ctx: WorkflowContext;
  phases: ShepherdPhases;
  target: PrTarget;
  state: LandPrState;
  /** The review taken at each green head this run saw; a head is reviewed once. */
  reviews: Map<string, Verdict>;
  /** The run param narrowed by every registration read so far; it only ever tightens. */
  policy: EffectivePolicy;
  policyReads: number;
  lastCi?: CiSnapshot;
}

/** Thrown out of `land` to end the round early: with no outcome the next round lands, with one the run ends. */
class LeaveLand extends Error {
  constructor(readonly outcome?: LandOutcome) {
    super(outcome ? `left land: ${outcome.kind}` : "left land for the next round");
  }
}

/**
 * Shepherd one PR to a merge: wait for the PR to exist, then land it round by round. A red head, a conflict, or a
 * review that sends the PR back wakes an agent first; an unhandled wake leaves the decision to a human.
 */
export async function shepherdPr(ctx: WorkflowContext, params: ShepherdPrParams, phases: ShepherdPhases): Promise<LandOutcome> {
  const pr = params.pr ?? (await step(ctx, "sh-await-pr", { repo: params.repo, branch: params.branch, runId: ctx.runId }, AwaitPrResult)).pr;
  const run: ShepherdRun = { ctx, phases, target: { repo: params.repo, pr }, state: { round: 0, reruns: 0, waits: 0 }, reviews: new Map(), policy: params.policy, policyReads: 0 };
  const verdictFor = (headSha: string) => run.reviews.get(headSha);
  const options: LandOptions = shepherdLandOptions(() => run.policy, verdictFor);
  const reviewing = reviewingContext(run);
  for (;;) {
    const outcome = await landRound(reviewing, run, options);
    const final = outcome && (await afterLand(run, outcome));
    if (final) return final.kind === "merged" ? landed(ctx, run.target, final, params.after) : final;
    run.state.round += 1;
  }
}

/** Undefined means a review send-back ended this round from inside `land` and the next round lands. */
async function landRound(ctx: WorkflowContext, run: ShepherdRun, options: LandOptions): Promise<LandOutcome | undefined> {
  try {
    return await land(ctx, { ...run.target, method: run.policy.mergeMethod, round: run.state.round }, options);
  } catch (error) {
    if (error instanceof LeaveLand) return error.outcome;
    throw error;
  }
}

/** Undefined means land the next round; anything else ends the run. */
async function afterLand(run: ShepherdRun, outcome: LandOutcome): Promise<LandOutcome | undefined> {
  if (outcome.kind === "ci-failed") {
    if (await woken(run, "ci-red", outcome.headSha, { failing: outcome.failing })) return undefined;
    return onCiFailed(run.ctx, run.target, outcome, run.state);
  }
  if (isConflict(run, outcome) && (await woken(run, "conflict", outcome.headSha, { mergeableState: "dirty" }))) return undefined;
  return outcome;
}

function isConflict(run: ShepherdRun, outcome: LandOutcome): boolean {
  if (outcome.kind !== "stopped" || outcome.reason !== "not-mergeable") return false;
  return run.lastCi?.headSha === outcome.headSha && run.lastCi.mergeableState === "dirty";
}

/** A woken agent has already awaited its new head, so the caller goes straight to the next land round. */
async function woken(run: ShepherdRun, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<boolean> {
  const outcome = await run.phases.wake(run.ctx, { kind, ...run.target, round: run.state.round, headSha, payload });
  return outcome.kind === "woken";
}

/** Runs the review at every green head `land` reads, before `land` asks the policy or the owner about that head. */
function reviewingContext(run: ShepherdRun): WorkflowContext {
  const { ctx } = run;
  return {
    runId: ctx.runId,
    workflowName: ctx.workflowName,
    signal: ctx.signal,
    param: (key) => ctx.param(key),
    iteration: (stepId) => ctx.iteration(stepId),
    seed: (stepId, fn) => ctx.seed(stepId, fn),
    assisted: (stepId, prompt, options) => ctx.assisted(stepId, prompt, options),
    dispatch: async (stepId, template, options) => {
      const done = await ctx.dispatch(stepId, template, options);
      if (stepIdMatches("ci-wait", stepId)) await onCiRead(run, done.data?.result);
      return done;
    },
  };
}

/** A head a review sent back is sent back again whenever it is green, so its verdict never reaches the merge decision. */
async function onCiRead(run: ShepherdRun, result: unknown): Promise<void> {
  const ci = CiSnapshotResult.safeParse(result);
  if (!ci.success) return;
  run.lastCi = ci.data;
  if (ci.data.verdict !== "green") return;
  const { headSha } = ci.data;
  if (!run.reviews.has(headSha)) {
    await parkAtGreen(run.ctx, headSha);
    run.reviews.set(headSha, await reviewHead(run, headSha));
  }
  await sendBack(run, headSha, run.reviews.get(headSha)!);
  await narrowToRegistration(run);
}

/** Where each verdict sends the PR back to; MERGE and none fall through to the merge decision. */
const SEND_BACK: Partial<Record<Verdict["kind"], WakeRequest["kind"]>> = { FIX_FIRST: "review", NO_REPRO: "fix-proof" };

/** A verdict about another head is ignored, so a stale review can neither send back nor vouch for this head. */
async function reviewHead(run: ShepherdRun, headSha: string): Promise<Verdict> {
  const verdict = await run.phases.review(run.ctx, { ...run.target, round: run.state.round, headSha });
  return verdict.kind === "none" || verdict.headSha === headSha ? verdict : { kind: "none" };
}

async function sendBack(run: ShepherdRun, headSha: string, verdict: Verdict): Promise<void> {
  const wake = SEND_BACK[verdict.kind];
  if (!wake) return;
  if (await woken(run, wake, headSha, verdict)) throw new LeaveLand();
  throw new LeaveLand(await unhandledSendBack(run, verdict.kind, headSha));
}

const SentBackAnswer = z.object({ decision: z.enum(["await-new-head", "abandon"]) });

/** No agent took the send-back, so a human chooses between waiting for a fix and abandoning; merging is not offered. */
async function unhandledSendBack(run: ShepherdRun, kind: Verdict["kind"], headSha: string): Promise<LandOutcome | undefined> {
  const prompt = `The review of PR #${run.target.pr} in ${run.target.repo} at head ${headSha} said ${kind}, and no agent took the wake. Await a new head or abandon?`;
  const answer = SentBackAnswer.parse((await run.ctx.assisted("sh-sent-back", prompt, { schema: SentBackAnswer })).data);
  if (answer.decision === "abandon") return { kind: "stopped", reason: "abandoned", headSha, detail: `a human abandoned the PR after a ${kind} review` };
  await step(run.ctx, `await-new-head:${run.state.waits++}`, { ...run.target, headSha }, AwaitHeadResult);
  return undefined;
}

const RegistrationPolicyResult = z.looseObject({ policy: EffectivePolicySchema.nullable() });

/** Read before every merge decision, because the registration may land after the run starts. */
async function narrowToRegistration(run: ShepherdRun): Promise<void> {
  const { policy } = await step(run.ctx, `sh-policy:${run.policyReads++}`, { runId: run.ctx.runId }, RegistrationPolicyResult);
  if (policy) run.policy = stricterPolicy(policy, run.policy);
}

/** The one place a merged outcome leaves the run; follow-ups that act on a merge extend this. */
async function landed(ctx: WorkflowContext, target: PrTarget, merged: Extract<LandOutcome, { kind: "merged" }>, after: readonly AfterStage[]): Promise<LandOutcome> {
  await step(ctx, "sh-landed", { ...target, headSha: merged.headSha, mergeSha: merged.mergeSha }, LandedResult);
  await shepherdMainCi(ctx, { ...target, mergeSha: merged.mergeSha }, after);
  return merged;
}

const AwaitPrResult = z.looseObject({ pr: z.number().int().positive(), headSha: z.string() });
const LandedResult = z.looseObject({ mergeSha: z.string() });

interface AwaitPrInput {
  repo: RepoSlug;
  branch: string;
  runId: string;
}

/** No timeout, because a PR can take days to open; a failed read is polled again, and the step's signal aborts the wait. */
async function awaitPr(deps: ShepherdDeps, input: AwaitPrInput, signal: AbortSignal): Promise<object> {
  for (;;) {
    signal.throwIfAborted();
    const found = await deps.port.findPr(input.repo, input.branch).catch(() => null);
    if (found && (found.state === "open" || found.merged)) {
      deps.store.get().setPr(input.runId, found.number);
      return { pr: found.number, headSha: found.headSha };
    }
    await deps.sleep(deps.pollMs ?? SH_AWAIT_PR_POLL_MS, signal);
  }
}

export interface ShepherdWiring {
  /** Absent means the review steps answer `none` and the owner gate decides. */
  review?: ReviewWiring;
  /** Absent means `agent-chat agent park` through `deps.agentChatBin`. */
  park?: ParkPort;
}

/** The routes only shepherd-pr dispatches to; each reads before it writes, so each repeats safely after a crash. */
export function shepherdRoutes(deps: ShepherdDeps, wiring: ShepherdWiring = {}): StepRoute[] {
  return [
    codeRoute("sh-await-pr", deps.now, (input: AwaitPrInput, signal) => awaitPr(deps, input, signal)),
    codeRoute("sh-landed", deps.now, async (input: object) => input),
    codeRoute("sh-policy", deps.now, async (input: { runId: string }) => ({ policy: deps.store.get().byRun(input.runId)?.policy ?? null })),
    ...wakeRoutes(deps),
    ...parkRoutes(deps, wiring.park),
    ...reviewRoutes(deps, wiring.review),
    ...postMergeRoutes(deps),
  ];
}

export const DEFAULT_PHASES: ShepherdPhases = { wake: wakePhase, review: reviewPhase };

/** The registered workflow; params `repo`, `pr` or `branch`, and `policy` as an `EffectivePolicy` JSON string. */
export function shepherdPrWorkflow(phases: ShepherdPhases = DEFAULT_PHASES): WorkflowDefinition {
  return defineWorkflow({ name: "shepherd-pr", steps: SHEPHERD_STEPS, run: async (ctx) => void (await shepherdPr(ctx, shepherdPrParams(ctx), phases)) });
}
