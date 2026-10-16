import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { defineWorkflow, stepIdMatches, type WorkflowDefinition } from "../definition.js";
import type { LandPrState } from "../workflows/land-pr.js";
import { CiSnapshotResult, UpdateResultResult } from "../workflows/land-steps.js";
import type { SettleHold } from "../workflows/land-settle.js";
import { codeRoute, land, newUpdateBound, type CiSnapshot, type LandOptions, type LandOutcome, type UpdateBound } from "../workflows/land.js";
import { awaitPrRoute, awaitPrStep } from "./await-pr.js";
import { behindAt, inheritEscalation, reviewable } from "./behind.js";
import { followingApprovals } from "./approval-carry.js";
import { classifyingFailures } from "./failure-class.js";
import { carriedVerdict, carryRoutes } from "./carry-merge.js";
import { freezeHoldRoutes, heldByFrozenMain } from "./freeze-hold.js";
import { conflictCheckRoute, conflictCheckedGates, conflictsAt } from "./conflict-check.js";
import type { MainRedWiring } from "./main-red.js";
import { parkAtGreen, parkRoutes, type ParkPort } from "./park.js";
import type { SeatHeld, ShepherdDeps, ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { ownerBriefAt, verdictIsMergeAt } from "../gate-brief.js";
import { shepherdLandOptions, type EffectivePolicy } from "./policy.js";
import { shepherdPrParams, type ShepherdPrParams } from "./pr-params.js";
import { g10ReleaseRoutes, releaseBeforeLeaving, releaseG10Hold } from "./g10-release.js";
import { g10ReholdRoutes, reholdMovedHead } from "./g10-rehold.js";
import { narrowToRegistration, registrationPolicy } from "./registration-policy.js";
import { type AfterStage, postMergeRoutes, shepherdMainCi } from "./post-merge.js";
import { npmRegistry, releaseFollowStep, releaseLandOptions, releasePreflightAt, releaseRoutes, releaseVerdict, type PackageRegistry } from "./release.js";
import { npmVersionRegistry, type VersionRegistry } from "./release-follow.js";
import { publishOutcome } from "./publish-review.js";
import { reviewPhase, reviewRoutes, type ReviewWiring } from "./review.js";
import { standingVerdict } from "./review-request.js";
import { reviewKeepingSeatHold } from "./seat-recheck.js";
import { reviewRefusedRoute, standingMerge } from "./merge-standing.js";
import { LeaveLand } from "./leave-land.js";
import { observePr, observeRoute } from "./observe.js";
import { recordedRoute } from "./recorded-route.js";
import { newCauseTrail, noteCarryStep, takeCause, tapped, type CarryProbe, type CauseTrail } from "./review-cause.js";
import { clearSuperseded, expireStaleGates, supersedingGates } from "./stale-gates.js";
import { recordingOverrides } from "./override-gate.js";
import { outcomeRoutes, recordLanded, recordOverride, recordStopped } from "./outcome.js";
import { leaveTrain } from "./train.js";
import { routeFor, type CloserStreak, type Escalated } from "./route-table.js";
import { countRound, endedOutcome, type Routed } from "./routed.js";
import { wakePhase, wakeRoutes } from "./wake.js";
import { awaitedPast, conflictGate, liveEscalation, type PrTarget, type WakeRun } from "./gates.js";
import { ciFailedRoute, routingStuckBehind, seatNoticeRoute, unhandledSendBack, unsettledMergeNotice } from "./gate-route.js";
import { afterWake, repairGate, spendRepair } from "./repair.js";
import { heldRepair, heldRepairRoutes } from "./held-repair.js";
import { headOriginRoute, recordHeadOrigin } from "./head-origin.js";
import { taskIdOf } from "../workflows/land-merge-message.js";
import { SHEPHERD_STEPS } from "./shepherd-steps.js";
import { withEarlier, type FixFirstTrail } from "./fix-first-trail.js";

export { SHEPHERD_STEPS };

interface ShepherdRun extends WakeRun, FixFirstTrail {
  ctx: WorkflowContext;
  phases: ShepherdPhases;
  target: PrTarget;
  state: LandPrState;
  /** The review taken at each green head this run saw; a head is reviewed once. */
  reviews: Map<string, Verdict>;
  /** Every MERGE the run took, by head; clearing `reviews` for a re-ask never clears it, so a MERGE head is never reviewed again. */
  merged: Map<string, Verdict>;
  /** The run param narrowed by every registration read so far; it only ever tightens. */
  policy: EffectivePolicy;
  policyReads: number;
  carryScopeReads: number;
  release: boolean;
  task?: string;
  lastCi?: CiSnapshot;
  /** Stuck rounds at this task: a silent or timed-out reviewer, an unanswered hold, or a conflict. */
  failedRounds: number;
  /** Throttled rounds at this run; up to `MAX_THROTTLED_ROUNDS` count no round. */
  throttledRounds: number;
  /** The consecutive FIX_FIRSTs that said Closer: no; the FIX_FIRST count itself is `fixFirstCount(ctx)`. */
  closer: CloserStreak;
  /** Conflict wakes since the PR was last green; a conflict that survives one goes to the owner. */
  conflictWakes: number;
  conflictChecks: number;
  /** Red heads checked against a frozen main's failures. */
  freezeChecks: number;
  /** Heads whose next review spawns a never-held reviewer. */
  fresh: Set<string>;
  /** Shepherd's own MERGE a seat held at each head; that head's next review re-checks the seat only. */
  seatHeld: Map<string, SeatHeld>;
  seatHeldRounds: Map<string, number>;
  /** Update-branch calls since the last human gate across every round; replaying the run's recorded steps rebuilds it, so a restart keeps the count. */
  updateBound: UpdateBound;
  /** The unsettled-merge wait at a head across every round; replay rebuilds it like the update bound. */
  settleHold: SettleHold;
  /** Heads whose merge decision is the owner's, with why. */
  escalations: Map<string, Escalated>;
  /** What names the next review's cause. */
  trail: CauseTrail;
}

/**
 * Shepherd one PR to a merge: wait for the PR to exist, then land it round by round. A red head, a conflict, or a
 * review that sends the PR back wakes an agent first; an unhandled wake leaves the decision to a human.
 */
export async function shepherdPr(ctx: WorkflowContext, params: ShepherdPrParams, phases: ShepherdPhases): Promise<LandOutcome> {
  const pr = params.pr ?? (await awaitPrStep(ctx, params.repo, params.branch));
  const run: ShepherdRun = {
    ...{ ctx, phases, target: { repo: params.repo, pr }, state: { round: 0, reruns: 0, waits: 0 }, reviews: new Map(), merged: new Map() },
    ...{ policy: params.policy, policyReads: 0, carryScopeReads: 0, release: params.release, task: params.task },
    ...{ failedRounds: 0, throttledRounds: 0, closer: { streak: 0 }, conflictWakes: 0, conflictChecks: 0, freezeChecks: 0, fresh: new Set() },
    ...{ seatHeld: new Map(), seatHeldRounds: new Map(), updateBound: newUpdateBound(), settleHold: {}, escalations: new Map() },
    ...{ wokenPast: new Set(), trail: newCauseTrail(), fixFirstTrail: [] },
  };
  const verdictFor = (headSha: string) => run.reviews.get(headSha);
  const options: LandOptions = run.release ? releaseLandOptions(() => run.policy, verdictFor) : shepherdOptions(run, verdictFor);
  const reviewing = reviewingContext(run);
  for (;;) {
    const outcome = await landRound(reviewing, run, options);
    await leaveTrain(ctx, params.repo, run.state.round);
    const final = outcome && (await afterLand(run, outcome));
    if (final) return final.kind === "merged" ? landed(ctx, run, final, params.after) : recordStopped(ctx, final);
    run.state.round += 1;
  }
}

/** An unsettled mergeability past its bound is the seat's to hear about, never an owner gate, while land keeps re-reading. */
function shepherdOptions(run: ShepherdRun, verdictFor: (headSha: string) => Verdict | undefined): LandOptions {
  const options = shepherdLandOptions(() => run.policy, verdictFor, (headSha) => liveEscalation(run, headSha));
  const unsettled = options.unsettled && { ...options.unsettled, notice: unsettledMergeNotice(run) };
  const merge = { reviewedMerge: (headSha: string) => verdictIsMergeAt(verdictFor(headSha), headSha) };
  return { ...options, ...(unsettled && { unsettled }), ...merge, ownerBriefAt: (headSha) => ownerBriefAt(verdictFor(headSha), headSha) };
}

/** Undefined means a review send-back ended this round from inside `land` and the next round lands. */
async function landRound(ctx: WorkflowContext, run: ShepherdRun, options: LandOptions): Promise<LandOutcome | undefined> {
  try {
    return await land(ctx, { ...run.target, method: run.policy.mergeMethod, taskIds: taskIdOf(run.task), round: run.state.round, updateBound: run.updateBound, settleHold: run.settleHold }, options);
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
    const held = await heldByFrozenMain(run, outcome, run.freezeChecks++);
    if (held !== false) return held === true ? undefined : held;
    if (await woken(run, "ci-red", outcome.headSha, { failing: outcome.failing })) return undefined;
    return ciFailedRoute(run, outcome);
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
 * a wake past the budget asks the owner instead and leaves the round. A held run spends none, unless `heldRepair` lets it.
 */
async function woken(run: ShepherdRun, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<boolean> {
  run.trail.woken = kind;
  if (await awaitedPast(run, headSha)) return true;
  if (await heldRepair(run, kind, headSha, payload)) return true;
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
  const reviewedMerge = (headSha: string): boolean => !run.release && verdictIsMergeAt(run.reviews.get(headSha), headSha);
  const supersede = (rereview: string | undefined, gated: string | undefined, stepId: string): LeaveLand => (
    clearSuperseded(run, rereview, gated, stepId), rereview && run.trail.ownerAsked.add(rereview), new LeaveLand()
  );
  const conflictCheck = (headSha: string) => conflictsAt(ctx, `sh-conflict-check:${run.conflictChecks++}`, { ...run.target, headSha });
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
    assisted: routingStuckBehind(run, () => run.lastCi?.headSha, recordingOverrides(followingApprovals(ctx, conflictCheckedGates(
      supersedingGates(ctx, supersede, () => (run.carried = undefined)), conflictCheck, leaveOnConflict), { target: run.target, reviewedMerge }),
      reviewedMerge, (override) => recordOverride(ctx, run.target, override))),
    authorize: (stepId, request, options) => ctx.authorize(stepId, request, options),
    dispatch: async (stepId, template, options) => {
      const done = await ctx.dispatch(stepId, template, options);
      if (stepIdMatches("ci-wait", stepId)) await onCiRead(run, done.data?.result);
      if (stepIdMatches("update-branch", stepId)) onUpdated(run, done.data?.result);
      return done;
    },
  };
}

function onUpdated(run: ShepherdRun, result: unknown): void {
  inheritEscalation(run.escalations, run.lastCi, result);
  const update = UpdateResultResult.safeParse(result);
  if (update.success && update.data.own) run.trail.updated.add(update.data.headSha);
}

/** A reviewable head is reviewed once, then routed by the table; only the `merge` route reaches `land`'s merge decision. */
async function onCiRead(run: ShepherdRun, result: unknown): Promise<void> {
  const ci = CiSnapshotResult.safeParse(result);
  if (!ci.success) return;
  await recordHeadOrigin(run, ci.data);
  run.lastCi = ci.data;
  expireStaleGates(run.ctx, ci.data.headSha);
  await reholdMovedHead(run, ci.data.headSha);
  if (!reviewable(ci.data)) return;
  if (ci.data.verdict === "green") run.conflictWakes = 0;
  await routeGreenHead(run, ci.data.headSha);
  await releaseG10Hold(run, await narrowToRegistration(run));
}

async function routeGreenHead(run: ShepherdRun, headSha: string): Promise<void> {
  if (!run.reviews.has(headSha) && !run.release) await parkAtGreen(run.ctx, headSha);
  for (;;) {
    const verdict = (await standingVerdict(run, headSha)) ?? (await reviewHead(run, headSha));
    if (verdict.kind !== "none" || verdict.cause !== "account-exhausted") run.reviews.set(headSha, verdict); // an account hold is no review; the head is reviewed once the hold lifts
    if (verdict.kind === "MERGE") run.merged.set(headSha, verdict);
    const observed = await observePr(run.ctx, run.target, headSha);
    const outcome = await publishOutcome(run.ctx, run.target, verdict, observed, headSha);
    run.trail.last = { headSha, outcome, verdict };
    const routed: Routed = { headSha, verdict, observed, outcome, route: recordedRoute(run.ctx, headSha, routeFor(observed.runState, observed.mergeableState, outcome)) };
    if (await takeRoute(run, routed)) return;
  }
}

/** True goes on to the merge decision, false reviews the same head again; every other route leaves this land round. */
async function takeRoute(run: ShepherdRun, routed: Routed): Promise<boolean> {
  const { route, headSha } = routed;
  const escalated = await countRound(run, routed);
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
      await releaseBeforeLeaving(run);
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

/**
 * A head that already took a MERGE keeps it and only has its evidence read again; a tree-equal update of a reviewed head
 * carries its MERGE; otherwise a verdict about another head is ignored, so a stale review can neither send back nor vouch for this head.
 */
async function reviewHead(run: ShepherdRun, headSha: string): Promise<Verdict> {
  if (run.release) return releaseVerdict(run.ctx, { ...run.target, head: headSha }, run.policy);
  const merged = run.merged.get(headSha);
  const standing = merged && (await standingMerge(run.ctx, merged, headSha, () => takeCause(run.trail, headSha, {})));
  if (standing) return standing;
  const probe: CarryProbe = {};
  const tap = tapped(run.ctx, (stepId, result) => noteCarryStep(probe, stepId, result));
  const carried = run.trail.seatAsked.has(headSha) ? undefined : await carriedVerdict(tap, run.target, run.reviews, headSha, run.carryScopeReads++);
  if (carried) return carried;
  const cause = takeCause(run.trail, headSha, probe);
  const request = { ...run.target, round: run.state.round, headSha };
  const verdict = await reviewKeepingSeatHold(run.seatHeld, headSha, (seatHeld) =>
    run.phases.review(run.ctx, { ...request, ...(run.fresh.has(headSha) && { fresh: true }), cause, ...(seatHeld && { seatHeld }) }));
  return verdict.kind === "none" || verdict.headSha === headSha ? verdict : { kind: "none", cause: "no-verdict" };
}

/** Where each verdict sends the PR back to. */
const SEND_BACK: Partial<Record<Verdict["kind"], WakeRequest["kind"]>> = { FIX_FIRST: "review", NO_REPRO: "fix-proof" };

/** Never returns: a woken agent starts the next round, and an unhandled wake asks a human. */
async function sendBack(run: ShepherdRun, headSha: string, verdict: Verdict): Promise<never> {
  const wake = SEND_BACK[verdict.kind];
  if (!wake) throw new Error(`shepherd-pr: a ${verdict.kind} verdict has no send-back`);
  if (await woken(run, wake, headSha, wake === "review" ? withEarlier(verdict, run.fixFirstTrail, headSha) : verdict)) throw new LeaveLand();
  throw new LeaveLand(await unhandledSendBack(run, verdict.kind, headSha));
}

/** One fixer attempt per conflict; a conflict that survives it goes to the owner. Undefined lands the next round. */
async function onConflict(run: ShepherdRun, headSha: string): Promise<LandOutcome | undefined> {
  if (run.conflictWakes >= 1) return conflictGate(run, headSha);
  run.conflictWakes += 1;
  if (await woken(run, "conflict", headSha, { mergeableState: "dirty" })) return undefined;
  return { kind: "stopped", reason: "not-mergeable", headSha, detail: "mergeable_state is dirty and no agent took the conflict wake" };
}

/** The one place a merged outcome leaves the run; follow-ups that act on a merge extend this. */
async function landed(ctx: WorkflowContext, run: ShepherdRun, merged: Extract<LandOutcome, { kind: "merged" }>, after: readonly AfterStage[]): Promise<LandOutcome> {
  await recordLanded(ctx, run.target, merged);
  // The main-CI read answers `none` for an empty merge sha and hands that run to the owner.
  const own = { ...(merged.own && { own: true as const }) };
  const mainCi = await shepherdMainCi(ctx, { ...run.target, mergeSha: merged.mergeSha ?? "", ...(merged.landed && { landed: merged.landed }), ...own }, after, run.policy.fixer);
  // A red or unread main already went to its own route, and a release built on it would not publish.
  const versions = () => releasePreflightAt(merged.headSha, (headSha) => run.reviews.get(headSha))?.versions ?? {};
  if (run.release && mainCi.verdict === "green" && merged.mergeSha) await releaseFollowStep(ctx, { ...run.target, mergeSha: merged.mergeSha }, versions());
  return merged;
}

export interface ShepherdWiring {
  /** Absent means the review steps answer `none` and the owner gate decides. */
  review?: ReviewWiring;
  /** Absent means `agent-chat agent park` through `deps.agentChatBin`. */
  park?: ParkPort;
  /** Absent means registry.npmjs.org over `fetch`. */
  registry?: PackageRegistry;
  /** Where a merged release's versions are looked up; absent means registry.npmjs.org over `fetch`. */
  versions?: VersionRegistry;
  /** The freeze store and the task and fixer ports a red main uses; absent means a red main goes to the owner, unfrozen. */
  mainRed?: MainRedWiring;
}

/** The routes only shepherd-pr dispatches to; each reads before it writes, so each repeats safely after a crash. */
export function shepherdRoutes(deps: ShepherdDeps, wiring: ShepherdWiring = {}): StepRoute[] {
  return [
    awaitPrRoute(deps),
    ...outcomeRoutes(deps.now),
    codeRoute("sh-policy", deps.now, async (input: { runId: string }) => registrationPolicy(deps.store.get(), input.runId)),
    ...wakeRoutes(deps),
    ...parkRoutes(deps, wiring.park),
    ...reviewRoutes(deps, wiring.review),
    ...carryRoutes(deps, wiring.review),
    ...releaseRoutes(deps, wiring.registry ?? npmRegistry(), wiring.versions ?? npmVersionRegistry(), wiring.mainRed?.tasks),
    ...postMergeRoutes(deps, wiring.mainRed),
    observeRoute(deps.port, deps.now, deps.snapshot),
    conflictCheckRoute(deps),
    seatNoticeRoute(deps.now, deps.exitNotice, deps.sleep),
    ...freezeHoldRoutes(deps, wiring.mainRed?.freezes),
    ...g10ReleaseRoutes(deps),
    ...g10ReholdRoutes(deps, wiring.review?.carry),
    ...heldRepairRoutes(deps),
    headOriginRoute(deps),
    reviewRefusedRoute(deps.now),
  ];
}

export const DEFAULT_PHASES: ShepherdPhases = { wake: wakePhase, review: reviewPhase };

/** The registered workflow; params `repo`, `pr` or `branch`, and `policy` as an `EffectivePolicy` JSON string. */
export function shepherdPrWorkflow(phases: ShepherdPhases = DEFAULT_PHASES): WorkflowDefinition {
  return defineWorkflow({ name: "shepherd-pr", steps: SHEPHERD_STEPS, run: classifyingFailures(async (ctx) => void (await shepherdPr(ctx, shepherdPrParams(ctx), phases))) });
}
