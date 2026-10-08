import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { defineWorkflow, stepIdMatches, type StepDeclaration, type WorkflowDefinition } from "../definition.js";
import { AWAIT_HEAD_STEPS } from "../workflows/await-head.js";
import { onCiFailed, type LandPrState } from "../workflows/land-pr.js";
import { CiSnapshotResult } from "../workflows/land-steps.js";
import type { SettleHold } from "../workflows/land-settle.js";
import { LAND_STEPS, codeRoute, land, newUpdateBound, type CiSnapshot, type LandOptions, type LandOutcome, type UpdateBound } from "../workflows/land.js";
import { awaitPrRoute, awaitPrStep } from "./await-pr.js";
import { behindAt, inheritEscalation, reviewable } from "./behind.js";
import { followingApprovals } from "./approval-carry.js";
import { CARRY_SCOPE_STEPS, carriedVerdict, carryRoutes } from "./carry-merge.js";
import { FREEZE_HOLD_STEPS, freezeHoldRoutes, heldByFrozenMain } from "./freeze-hold.js";
import { CONFLICT_CHECK_STEPS, conflictCheckRoute, conflictCheckedGates, conflictsAt } from "./conflict-check.js";
import type { MainRedWiring } from "./main-red.js";
import { PARK_STEPS, parkAtGreen, parkRoutes, type ParkPort } from "./park.js";
import type { ShepherdDeps, ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { verdictIsMergeAt } from "../gate-brief.js";
import { EffectivePolicySchema, OWNER_GATE_POLICY, shepherdLandOptions, type EffectivePolicy } from "./policy.js";
import { narrowToRegistration } from "./registration-policy.js";
import { POST_MERGE_STEPS, afterStages, type AfterStage, postMergeRoutes, shepherdMainCi } from "./post-merge.js";
import { RELEASE_STEPS, VERSION_PACKAGES_BRANCH, npmRegistry, releaseLandOptions, releaseRoutes, releaseVerdict, type PackageRegistry } from "./release.js";
import { publishOutcome } from "./publish-review.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes, type ReviewWiring } from "./review.js";
import { OBSERVE_STEPS, observePr, observeRoute, type ObservedPr } from "./observe.js";
import { recordedRoute } from "./recorded-route.js";
import { expireStaleGates, supersedingGates } from "./stale-gates.js";
import { OUTCOME_STEPS, outcomeRoutes, recordLanded, recordStopped } from "./outcome.js";
import { leaveTrain } from "./train.js";
import { FAILED_ROUND_WORDS, MAX_FAILED_ROUNDS, fixFirstEscalation, nextCloserStreak, roundKind, routeFor, type CloserStreak, type Escalated, type ReviewOutcome, type Route } from "./route-table.js";
import { WAKE_STEPS, wakePhase, wakeRoutes } from "./wake.js";
import { awaitedPast, conflictGate, sentBackGate, type PrTarget, type WakeRun } from "./gates.js";
import { afterWake, repairGate, spendRepair } from "./repair.js";

/** Steps shared with land-pr are declared here too; their routes are registered once, in `factoryRoutes`. */
export const SHEPHERD_STEPS: readonly StepDeclaration[] = [
  ...LAND_STEPS,
  ...AWAIT_HEAD_STEPS,
  { id: "rerun", kind: "dispatch" },
  { id: "ci-failed", kind: "assisted" },
  { id: "sh-await-pr", kind: "dispatch" },
  { id: "sh-policy", kind: "dispatch" },
  { id: "sh-sent-back", kind: "assisted" },
  { id: "sh-train-leave", kind: "dispatch" },
  ...WAKE_STEPS,
  ...PARK_STEPS,
  ...REVIEW_STEPS,
  ...CARRY_SCOPE_STEPS,
  ...RELEASE_STEPS,
  ...POST_MERGE_STEPS,
  ...OBSERVE_STEPS,
  ...OUTCOME_STEPS,
  ...CONFLICT_CHECK_STEPS,
  ...FREEZE_HOLD_STEPS,
];

export interface ShepherdPrParams {
  repo: RepoSlug;
  pr?: number;
  branch?: string;
  policy: EffectivePolicy;
  /** Parsed before land, so a malformed list fails the run before any merge. */
  after: AfterStage[];
  /** The changesets Version Packages PR: a release preflight stands in for the reviewer. */
  release: boolean;
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
  return { repo, ...(pr === undefined ? { branch: branch! } : { pr }), policy, after: afterStages(ctx), release: branch === VERSION_PACKAGES_BRANCH };
}

interface ShepherdRun extends WakeRun {
  ctx: WorkflowContext;
  phases: ShepherdPhases;
  target: PrTarget;
  state: LandPrState;
  /** The review taken at each green head this run saw; a head is reviewed once. */
  reviews: Map<string, Verdict>;
  /** The run param narrowed by every registration read so far; it only ever tightens. */
  policy: EffectivePolicy;
  policyReads: number;
  carryScopeReads: number;
  release: boolean;
  lastCi?: CiSnapshot;
  /** Stuck rounds at this task: a silent or timed-out reviewer, an unanswered hold, or a conflict. */
  failedRounds: number;
  /** FIX_FIRST reviews at this task, and the consecutive ones that said Closer: no; each is progress until a cap. */
  fixFirsts: number; closer: CloserStreak;
  /** Conflict wakes since the PR was last green; a conflict that survives one goes to the owner. */
  conflictWakes: number;
  conflictChecks: number;
  /** Red heads checked against a frozen main's failures. */
  freezeChecks: number;
  /** Heads whose next review spawns a never-held reviewer. */
  fresh: Set<string>;
  /** Update-branch calls since the last human gate across every round; replaying the run's recorded steps rebuilds it, so a restart keeps the count. */
  updateBound: UpdateBound;
  /** The unsettled-merge wait at a head across every round; replay rebuilds it like the update bound. */
  settleHold: SettleHold;
  /** Heads whose merge decision is the owner's, with why. */
  escalations: Map<string, Escalated>;
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
  const pr = params.pr ?? (await awaitPrStep(ctx, params.repo, params.branch));
  const run: ShepherdRun = {
    ...{ ctx, phases, target: { repo: params.repo, pr }, state: { round: 0, reruns: 0, waits: 0 }, reviews: new Map(), policy: params.policy, policyReads: 0, carryScopeReads: 0, release: params.release },
    ...{ failedRounds: 0, fixFirsts: 0, closer: { streak: 0 }, conflictWakes: 0, conflictChecks: 0, freezeChecks: 0, fresh: new Set(), updateBound: newUpdateBound(), settleHold: {}, escalations: new Map(), wokenPast: new Set() },
  };
  const verdictFor = (headSha: string) => run.reviews.get(headSha);
  const options: LandOptions = run.release ? releaseLandOptions(() => run.policy, verdictFor) : { ...shepherdLandOptions(() => run.policy, verdictFor, (headSha) => run.escalations.get(headSha)), reviewedMerge: (headSha) => verdictIsMergeAt(verdictFor(headSha), headSha) };
  const reviewing = reviewingContext(run);
  for (;;) {
    const outcome = await landRound(reviewing, run, options);
    await leaveTrain(ctx, params.repo, run.state.round);
    const final = outcome && (await afterLand(run, outcome));
    if (final) return final.kind === "merged" ? landed(ctx, run, final, params.after) : recordStopped(ctx, final);
    run.state.round += 1;
  }
}

/** Undefined means a review send-back ended this round from inside `land` and the next round lands. */
async function landRound(ctx: WorkflowContext, run: ShepherdRun, options: LandOptions): Promise<LandOutcome | undefined> {
  try {
    return await land(ctx, { ...run.target, method: run.policy.mergeMethod, round: run.state.round, updateBound: run.updateBound, settleHold: run.settleHold }, options);
  } catch (error) {
    if (error instanceof LeaveLand) return error.outcome;
    throw error;
  }
}

/** Undefined means land the next round; anything else ends the run. */
async function afterLand(run: ShepherdRun, outcome: LandOutcome): Promise<LandOutcome | undefined> {
  try {
    return await routeLanded(run, outcome);
  } catch (error) {
    if (error instanceof LeaveLand) return error.outcome;
    throw error;
  }
}

async function routeLanded(run: ShepherdRun, outcome: LandOutcome): Promise<LandOutcome | undefined> {
  if (outcome.kind === "ci-failed") {
    if (await heldByFrozenMain(run.ctx, run.target, outcome, run.freezeChecks++)) return undefined;
    if (await woken(run, "ci-red", outcome.headSha, { failing: outcome.failing })) return undefined;
    return onCiFailed(run.ctx, run.target, outcome, run.state);
  }
  if (!isConflict(run, outcome)) return outcome;
  run.failedRounds += 1;
  return onConflict(run, outcome.headSha);
}

function isConflict(run: ShepherdRun, outcome: LandOutcome): boolean {
  if (outcome.kind !== "stopped") return false;
  const dirty = outcome.reason === "not-mergeable" && run.lastCi?.headSha === outcome.headSha && run.lastCi.mergeableState === "dirty";
  return outcome.reason === "conflict" || dirty;
}

/**
 * A woken agent has already awaited its new head, so the caller goes straight to the next land round.
 * Every wake kind spends one repair budget per run, recorded as a step so a replay and a new head keep the count;
 * a wake past the budget asks the owner instead and leaves the round.
 */
async function woken(run: ShepherdRun, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<boolean> {
  if (await awaitedPast(run, headSha)) return true;
  if (!(await spendRepair(run.ctx, run.target, kind, headSha))) throw new LeaveLand(await repairGate(run, kind, headSha, payload));
  return afterWake(run, kind, headSha, payload, await run.phases.wake(run.ctx, { kind, ...run.target, round: run.state.round, headSha, payload }), (left) => new LeaveLand(left));
}

/** An approval at a head that conflicts with its base would only fail at update-branch, so the conflict goes back to the fixer. */
function leaveOnConflict(headSha: string): LeaveLand {
  return new LeaveLand({ kind: "stopped", reason: "conflict", headSha, detail: `the pull request at ${headSha} conflicts with its base` });
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
    historyNext: () => ctx.historyNext(),
    resumedGate: () => ctx.resumedGate(),
    expireGates: (reason, isStale) => ctx.expireGates(reason, isStale),
    seed: (stepId, fn) => ctx.seed(stepId, fn),
    assisted: followingApprovals(ctx, conflictCheckedGates(supersedingGates(ctx, (rereview) => (rereview === undefined || run.reviews.delete(rereview), new LeaveLand())), (headSha) => conflictsAt(ctx, `sh-conflict-check:${run.conflictChecks++}`, { ...run.target, headSha }), leaveOnConflict), { target: run.target, reviewedMerge: (headSha) => !run.release && verdictIsMergeAt(run.reviews.get(headSha), headSha) }),
    authorize: (stepId, request, options) => ctx.authorize(stepId, request, options),
    dispatch: async (stepId, template, options) => {
      const done = await ctx.dispatch(stepId, template, options);
      if (stepIdMatches("ci-wait", stepId)) await onCiRead(run, done.data?.result);
      if (stepIdMatches("update-branch", stepId)) inheritEscalation(run.escalations, run.lastCi, done.data?.result);
      return done;
    },
  };
}

/** A reviewable head is reviewed once, then routed by the table; only the `merge` route reaches `land`'s merge decision. */
async function onCiRead(run: ShepherdRun, result: unknown): Promise<void> {
  const ci = CiSnapshotResult.safeParse(result);
  if (!ci.success) return;
  run.lastCi = ci.data;
  expireStaleGates(run.ctx, ci.data.headSha);
  if (!reviewable(ci.data)) return;
  if (ci.data.verdict === "green") run.conflictWakes = 0;
  await routeGreenHead(run, ci.data.headSha);
  await narrowToRegistration(run);
}

async function routeGreenHead(run: ShepherdRun, headSha: string): Promise<void> {
  if (!run.reviews.has(headSha) && !run.release) await parkAtGreen(run.ctx, headSha);
  for (;;) {
    const verdict = run.reviews.get(headSha) ?? (await reviewHead(run, headSha));
    // An account hold is no review: the round it ends reads the head again and reviews it once the hold lifts.
    if (verdict.kind !== "none" || verdict.cause !== "account-exhausted") run.reviews.set(headSha, verdict);
    const observed = await observePr(run.ctx, run.target, headSha);
    const outcome = await publishOutcome(run.ctx, run.target, verdict, observed, headSha);
    const routed: Routed = { headSha, verdict, observed, outcome, route: recordedRoute(run.ctx, headSha, routeFor(observed.runState, observed.mergeableState, outcome)) };
    if (await takeRoute(run, routed)) return;
  }
}

interface Routed {
  headSha: string;
  verdict: Verdict;
  observed: ObservedPr;
  outcome: ReviewOutcome;
  route: Route;
}

/** Counts the round; a conflict's own escalation is `onConflict`'s, so a stuck conflict only adds to the count here. */
function countRound(run: ShepherdRun, routed: Routed): Escalated | undefined {
  const { route, outcome, headSha } = routed;
  const kind = roundKind(route, outcome);
  run.closer = nextCloserStreak(run.closer, kind, routed.verdict, headSha);
  if (kind === "fix-first") return fixFirstEscalation(++run.fixFirsts, run.closer.streak, headSha);
  if (kind !== "stuck") return undefined;
  run.failedRounds += 1;
  if (route === "wake-fixer" || run.failedRounds < MAX_FAILED_ROUNDS) return undefined;
  const ended = (routed.verdict.kind === "none" && routed.verdict.reason) || (FAILED_ROUND_WORDS[outcome] ?? outcome);
  return { escalation: "failed-rounds", detail: `the last at ${headSha} ended with ${ended}` };
}

/** True goes on to the merge decision, false reviews the same head again; every other route leaves this land round. */
async function takeRoute(run: ShepherdRun, routed: Routed): Promise<boolean> {
  const { route, headSha } = routed;
  const escalated = countRound(run, routed);
  if (escalated) {
    run.escalations.set(headSha, escalated);
    return true;
  }
  switch (route) {
    case "merge":
      return true;
    case "fresh-reviewer":
    case "retry-review":
    case "await-external":
      run.reviews.delete(headSha);
      if (route === "fresh-reviewer") run.fresh.add(headSha);
      return false;
    case "wake-fixer":
      if (routed.outcome === "FIX_FIRST") return sendBack(run, headSha, routed.verdict);
      throw new LeaveLand(await onConflict(run, headSha));
    case "end-run":
      throw new LeaveLand(endedOutcome(routed));
    case "update-branch":
    case "new-cycle":
    case "await-account":
      // A head behind a moved base lands as it stands, so only a MERGE verdict may take it to the merge decision.
      if (route === "update-branch" && behindAt(run.lastCi, headSha) && (routed.outcome === "MERGE" || run.lastCi?.baseMoved !== true)) return true;
      throw new LeaveLand();
  }
}

function endedOutcome({ observed, headSha }: Routed): LandOutcome {
  if (observed.runState === "merged-elsewhere") return { kind: "merged", headSha: observed.headSha, mergeSha: observed.mergeSha };
  if (observed.runState === "closed-elsewhere") return { kind: "stopped", reason: "closed", headSha, detail: "the pull request was closed outside Shepherd" };
  return { kind: "stopped", reason: "not-mergeable", headSha, detail: "the pull request is a draft" };
}

/** A tree-equal update of a reviewed head carries its MERGE; otherwise a verdict about another head is ignored, so a stale review can neither send back nor vouch for this head. */
async function reviewHead(run: ShepherdRun, headSha: string): Promise<Verdict> {
  if (run.release) return releaseVerdict(run.ctx, { ...run.target, head: headSha }, run.policy.merge);
  const carried = await carriedVerdict(run.ctx, run.target, run.reviews, headSha, run.carryScopeReads++);
  if (carried) return carried;
  const verdict = await run.phases.review(run.ctx, { ...run.target, round: run.state.round, headSha, ...(run.fresh.has(headSha) && { fresh: true }) });
  return verdict.kind === "none" || verdict.headSha === headSha ? verdict : { kind: "none", cause: "no-verdict" };
}

/** Where each verdict sends the PR back to. */
const SEND_BACK: Partial<Record<Verdict["kind"], WakeRequest["kind"]>> = { FIX_FIRST: "review", NO_REPRO: "fix-proof" };

/** Never returns: a woken agent starts the next round, and an unhandled wake asks a human. */
async function sendBack(run: ShepherdRun, headSha: string, verdict: Verdict): Promise<never> {
  const wake = SEND_BACK[verdict.kind];
  if (!wake) throw new Error(`shepherd-pr: a ${verdict.kind} verdict has no send-back`);
  if (await woken(run, wake, headSha, verdict)) throw new LeaveLand();
  throw new LeaveLand(await unhandledSendBack(run, verdict.kind, headSha));
}

/** One fixer attempt per conflict; a conflict that survives it goes to the owner. Undefined lands the next round. */
async function onConflict(run: ShepherdRun, headSha: string): Promise<LandOutcome | undefined> {
  if (run.conflictWakes >= 1) return conflictGate(run, headSha);
  run.conflictWakes += 1;
  if (await woken(run, "conflict", headSha, { mergeableState: "dirty" })) return undefined;
  return { kind: "stopped", reason: "not-mergeable", headSha, detail: "mergeable_state is dirty and no agent took the conflict wake" };
}

/** No agent took the send-back, so a human chooses between waiting for a fix and abandoning. */
function unhandledSendBack(run: ShepherdRun, kind: Verdict["kind"], headSha: string): Promise<LandOutcome | undefined> {
  const prompt = `The review of PR #${run.target.pr} in ${run.target.repo} at head ${headSha} said ${kind}, and no agent took the wake. Await a new head or abandon?`;
  return sentBackGate(run, headSha, prompt, `a human abandoned the PR after a ${kind} review`);
}

/** The one place a merged outcome leaves the run; follow-ups that act on a merge extend this. */
async function landed(ctx: WorkflowContext, run: ShepherdRun, merged: Extract<LandOutcome, { kind: "merged" }>, after: readonly AfterStage[]): Promise<LandOutcome> {
  await recordLanded(ctx, run.target, merged);
  // The main-CI read answers `none` for an empty merge sha and hands that run to the owner.
  await shepherdMainCi(ctx, { ...run.target, mergeSha: merged.mergeSha ?? "" }, after, run.policy.fixer);
  return merged;
}

export interface ShepherdWiring {
  /** Absent means the review steps answer `none` and the owner gate decides. */
  review?: ReviewWiring;
  /** Absent means `agent-chat agent park` through `deps.agentChatBin`. */
  park?: ParkPort;
  /** Absent means registry.npmjs.org over `fetch`. */
  registry?: PackageRegistry;
  /** The freeze store and the task and fixer ports a red main uses; absent means a red main goes to the owner, unfrozen. */
  mainRed?: MainRedWiring;
}

/** The routes only shepherd-pr dispatches to; each reads before it writes, so each repeats safely after a crash. */
export function shepherdRoutes(deps: ShepherdDeps, wiring: ShepherdWiring = {}): StepRoute[] {
  return [
    awaitPrRoute(deps),
    ...outcomeRoutes(deps.now),
    codeRoute("sh-policy", deps.now, async (input: { runId: string }) => ({ policy: deps.store.get().byRun(input.runId)?.policy ?? null })),
    ...wakeRoutes(deps),
    ...parkRoutes(deps, wiring.park),
    ...reviewRoutes(deps, wiring.review),
    ...carryRoutes(deps, wiring.review),
    ...releaseRoutes(deps, wiring.registry ?? npmRegistry()),
    ...postMergeRoutes(deps, wiring.mainRed),
    observeRoute(deps.port, deps.now, deps.snapshot),
    conflictCheckRoute(deps),
    ...freezeHoldRoutes(deps, wiring.mainRed?.freezes),
  ];
}

export const DEFAULT_PHASES: ShepherdPhases = { wake: wakePhase, review: reviewPhase };

/** The registered workflow; params `repo`, `pr` or `branch`, and `policy` as an `EffectivePolicy` JSON string. */
export function shepherdPrWorkflow(phases: ShepherdPhases = DEFAULT_PHASES): WorkflowDefinition {
  return defineWorkflow({ name: "shepherd-pr", steps: SHEPHERD_STEPS, run: async (ctx) => void (await shepherdPr(ctx, shepherdPrParams(ctx), phases)) });
}
