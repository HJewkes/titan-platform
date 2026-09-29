import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow, stepIdMatches, type StepDeclaration, type WorkflowDefinition } from "../definition.js";
import type { StepRoute } from "../routed-runner.js";
import { AWAIT_HEAD_STEPS } from "../workflows/await-head.js";
import { onCiFailed, type LandPrState } from "../workflows/land-pr.js";
import { CiSnapshotResult } from "../workflows/land-steps.js";
import { LAND_STEPS, codeRoute, land, step, type CiSnapshot, type LandOptions, type LandOutcome } from "../workflows/land.js";
import type { ShepherdDeps, ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { EffectivePolicySchema, OWNER_GATE_POLICY, shepherdGatePolicy, type EffectivePolicy } from "./policy.js";
import { POST_MERGE_STEPS, afterStages, postMergeRoutes, shepherdMainCi } from "./post-merge.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes } from "./review.js";
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
  ...WAKE_STEPS,
  ...REVIEW_STEPS,
  ...POST_MERGE_STEPS,
];

export interface ShepherdPrParams {
  repo: RepoSlug;
  pr?: number;
  branch?: string;
  policy: EffectivePolicy;
}

/** A run with no `policy` param gets the owner gate, the strictest mode that still lets a merge happen. */
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
  return { repo, ...(pr === undefined ? { branch: branch! } : { pr }), policy };
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
  lastCi?: CiSnapshot;
}

/** Thrown out of `land` when a woken agent has already pushed the head the next round lands. */
class NextRound extends Error {}

/**
 * Shepherd one PR to a merge: wait for the PR to exist, then land it round by round. A red head, a conflict, or a
 * review that sends the PR back wakes an agent first; an unhandled wake leaves the decision to a human.
 */
export async function shepherdPr(ctx: WorkflowContext, params: ShepherdPrParams, phases: ShepherdPhases): Promise<LandOutcome> {
  const pr = params.pr ?? (await step(ctx, "sh-await-pr", { repo: params.repo, branch: params.branch, runId: ctx.runId }, AwaitPrResult)).pr;
  const run: ShepherdRun = { ctx, phases, target: { repo: params.repo, pr }, state: { round: 0, reruns: 0, waits: 0 }, reviews: new Map() };
  const options: LandOptions = { policy: shepherdGatePolicy(params.policy, (headSha) => run.reviews.get(headSha)) };
  const reviewing = reviewingContext(run);
  for (;;) {
    const outcome = await landRound(reviewing, run, options, params.policy);
    const final = outcome && (await afterLand(run, outcome));
    if (final) return final.kind === "merged" ? landed(ctx, run.target, final) : final;
    run.state.round += 1;
  }
}

/** Undefined means a woken agent sent the run to the next round from inside `land`. */
async function landRound(ctx: WorkflowContext, run: ShepherdRun, options: LandOptions, policy: EffectivePolicy): Promise<LandOutcome | undefined> {
  try {
    return await land(ctx, { ...run.target, method: policy.mergeMethod, round: run.state.round }, options);
  } catch (error) {
    if (error instanceof NextRound) return undefined;
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

async function onCiRead(run: ShepherdRun, result: unknown): Promise<void> {
  const ci = CiSnapshotResult.safeParse(result);
  if (!ci.success) return;
  run.lastCi = ci.data;
  if (ci.data.verdict === "green" && !run.reviews.has(ci.data.headSha)) await reviewHead(run, ci.data.headSha);
}

/** Where each verdict sends the PR back to; MERGE and none fall through to the merge decision. */
const SEND_BACK: Partial<Record<Verdict["kind"], WakeRequest["kind"]>> = { FIX_FIRST: "review", NO_REPRO: "fix-proof" };

/** A verdict about another head is ignored, so a stale review can neither send back nor vouch for this head. */
async function reviewHead(run: ShepherdRun, headSha: string): Promise<void> {
  const verdict = await run.phases.review(run.ctx, { ...run.target, round: run.state.round, headSha });
  const current: Verdict = verdict.kind === "none" || verdict.headSha === headSha ? verdict : { kind: "none" };
  run.reviews.set(headSha, current);
  const sendBack = SEND_BACK[current.kind];
  if (sendBack && (await woken(run, sendBack, headSha, current))) throw new NextRound(`${current.kind} at ${headSha} woke an agent`);
}

/** The one place a merged outcome leaves the run; follow-ups that act on a merge extend this. */
async function landed(ctx: WorkflowContext, target: PrTarget, merged: Extract<LandOutcome, { kind: "merged" }>): Promise<LandOutcome> {
  await step(ctx, "sh-landed", { ...target, headSha: merged.headSha, mergeSha: merged.mergeSha }, LandedResult);
  await shepherdMainCi(ctx, { ...target, mergeSha: merged.mergeSha }, afterStages(ctx));
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

/** The routes only shepherd-pr dispatches to; each reads before it writes, so each repeats safely after a crash. */
export function shepherdRoutes(deps: ShepherdDeps): StepRoute[] {
  return [
    codeRoute("sh-await-pr", deps.now, (input: AwaitPrInput, signal) => awaitPr(deps, input, signal)),
    codeRoute("sh-landed", deps.now, async (input: object) => input),
    ...wakeRoutes(deps),
    ...reviewRoutes(deps),
    ...postMergeRoutes(deps),
  ];
}

export const DEFAULT_PHASES: ShepherdPhases = { wake: wakePhase, review: reviewPhase };

/** The registered workflow; params `repo`, `pr` or `branch`, and `policy` as an `EffectivePolicy` JSON string. */
export function shepherdPrWorkflow(phases: ShepherdPhases = DEFAULT_PHASES): WorkflowDefinition {
  return defineWorkflow({ name: "shepherd-pr", steps: SHEPHERD_STEPS, run: async (ctx) => void (await shepherdPr(ctx, shepherdPrParams(ctx), phases)) });
}
