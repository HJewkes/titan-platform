import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { defineWorkflow, stepIdMatches, type WorkflowDefinition } from "../definition.js";
import type { LandPrState } from "../workflows/land-pr.js";
import { CiSnapshotResult } from "../workflows/land-steps.js";
import type { SettleHold } from "../workflows/land-settle.js";
import { codeRoute, land, newUpdateBound, type CiSnapshot, type LandOptions, type LandOutcome, type UpdateBound } from "../workflows/land.js";
import { awaitPrRoute, awaitPrStep } from "./await-pr.js";
import { behindAt, onUpdated, reviewable } from "./behind.js";
import { followingApprovals } from "./approval-carry.js";
import { setCarryOf } from "./approved-set-carry.js";
import { classifyingFailures } from "./failure-class.js";
import { carriedVerdict, carryRoutes } from "./carry-merge.js";
import { freezeHoldRoutes, heldByFrozenMain } from "./freeze-hold.js";
import { fixPrStall } from "./fix-pr-stall.js";
import { conflictCheckRoute, conflictCheckedGates, conflictsAt, leaveOnConflict } from "./conflict-check.js";
import type { MainRedWiring } from "./main-red.js";
import { parkAtGreen, parkRoutes, type ParkPort } from "./park.js";
import type { SeatHeld, ShepherdDeps, ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { ciPolicyAt, ownerBriefAt, verdictIsMergeAt } from "../gate-brief.js";
import { checkedBaseTap, shepherdLandOptions, type EffectivePolicy } from "./policy.js";
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
import { LeaveLand, untilLeft } from "./leave-land.js";
import { observePr, observeRoute } from "./observe.js";
import { recordedRoute } from "./recorded-route.js";
import { newCauseTrail, noteCarryStep, takeCause, tapped, type CarryProbe, type CauseTrail } from "./review-cause.js";
import { clearSuperseded, expireStaleGates, supersedingGates } from "./stale-gates.js";
import { recordingOverrides } from "./override-gate.js";
import { outcomeRoutes, recordLanded, recordOverride, recordStopped } from "./outcome.js";
import { leaveTrain } from "./train.js";
import { routeFor, type CloserStreak, type Escalated } from "./route-table.js";
import { countRound, endedOutcome, routeEscalation, type Routed } from "./routed.js";
import { wakeRoutes } from "./wake.js";
import { wakePhase } from "./wake-phase.js";
import { awaitedPast, liveEscalation, type PrTarget, type WakeRun } from "./gates.js";
import { conflictBaseRoute } from "./conflict-base.js";
import { expireOrder } from "./merge-order-expiry.js";
import { conflictRound, isConflict, noteRetarget } from "./retarget-conflict.js";
import { staleBaseOf, staleBaseRoute, type StaleBaseRun } from "./stale-base.js";
import { mergeMainFirst, mergeMainRoute } from "./merge-main.js";
import { endOrderRound, releasedUnlessWoken, releaseOrder, releaseUnlandable, retakeOrder, unreserved } from "./merge-order-steps.js";
import { ciFailedRoute, routingStuckBehind, seatNoticeRoute, unhandledSendBack, unsettledMergeNotice } from "./gate-route.js";
import { afterWake, repairGate, spendRepair } from "./repair.js";
import { heldRepair, heldRepairRoutes } from "./held-repair.js";
import { headOriginRoute, recordHeadOrigin } from "./head-origin.js";
import { taskIdOf } from "../workflows/land-merge-message.js";
import { SHEPHERD_STEPS } from "./shepherd-steps.js";
import { convergenceOf, fixRoundOf, type FixFirstTrail } from "./fix-first-trail.js";
import { isVisualGate, packetBeforeGate, packetTriggering, visualPacketRoutes, type PacketRun } from "./visual-packet-trigger.js";
import { OWNER_SEND_BACK_KIND, isSentBack, ownerSendBack, sendBackOffer, sendBackOfferRoute } from "./owner-send-back.js";
import { NOT_OFFERED, configuredVisualSetCarry, visualAcceptOfferRoute, visualAcceptRoute, type VisualAcceptRun } from "./visual-accept.js";
import { autoPassRoute } from "./auto-pass.js";
import { countConflictRound, freshFailedRounds, tappedReview, type FailedRoundsState } from "./failed-rounds-demotion.js";
import { diagnosisRoutes } from "./no-verdict-diagnosis.js";
import { askingOnlyOverMerge, type NoMergeRun } from "./no-merge-no-ask.js";
import { sendBack } from "./send-back.js";

export { SHEPHERD_STEPS };

interface ShepherdRun extends WakeRun, FixFirstTrail, VisualAcceptRun, FailedRoundsState, NoMergeRun, StaleBaseRun {
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
    ...{ ...freshFailedRounds(), throttledRounds: 0, closer: { streak: 0 }, conflictWakes: 0, conflictChecks: 0, conflictBaseReads: 0, orderSteps: 0, freezeChecks: 0, fresh: new Set() },
    ...{ staleBases: new Set(), staleBaseReads: 0, seatHeld: new Map(), seatHeldRounds: new Map(), updateBound: newUpdateBound(), settleHold: {}, escalations: new Map() },
    ...{ wokenPast: new Set(), trail: newCauseTrail(), fixFirstTrail: [], visualAcceptOffers: 0, unreviewedAsks: new Set() },
  };
  const verdictFor = (headSha: string) => run.reviews.get(headSha);
  const checked = checkedBaseTap();
  const options: LandOptions = run.release ? releaseLandOptions(() => run.policy, verdictFor) : shepherdOptions(run, verdictFor, checked.base);
  const reviewing = checked.tapping(reviewingContext(run));
  for (;;) {
    run.resolving = false;
    const outcome = await landRound(reviewing, run, options);
    await leaveTrain(ctx, params.repo, run.state.round);
    await endOrderRound(run, outcome);
    const final = outcome && (await afterLand(run, outcome));
    if (final) await releaseOrder(run);
    if (final) return final.kind === "merged" ? landed(ctx, run, final, params.after) : recordStopped(ctx, final);
    run.state.round += 1;
  }
}

/** An unsettled mergeability past its bound is the seat's to hear about, never an owner gate, while land keeps re-reading. */
function shepherdOptions(run: ShepherdRun, verdictFor: (headSha: string) => Verdict | undefined, checkedBase: () => string | undefined): LandOptions {
  const options = shepherdLandOptions(() => run.policy, verdictFor, (headSha) => liveEscalation(run, headSha), checkedBase);
  const unsettled = options.unsettled && { ...options.unsettled, notice: unsettledMergeNotice(run), stalled: fixPrStall(run) };
  const merge = { reviewedMerge: (headSha: string) => verdictIsMergeAt(verdictFor(headSha), headSha) };
  const atHead = { ownerBriefAt: (headSha: string) => ownerBriefAt(verdictFor(headSha), headSha), ciPolicyAt: (headSha: string) => ciPolicyAt(verdictFor(headSha), headSha) };
  return { ...options, ...(unsettled && { unsettled }), ...merge, ...atHead, sendBackOffered: sendBackOffer(), mergeBaseFirst: mergeMainFirst(run.target.repo) };
}

/** Undefined means a review send-back ended this round from inside `land` and the next round lands. */
function landRound(ctx: WorkflowContext, run: ShepherdRun, options: LandOptions): Promise<LandOutcome | undefined> {
  const request = { ...run.target, method: run.policy.mergeMethod, taskIds: taskIdOf(run.task), round: run.state.round, updateBound: run.updateBound, settleHold: run.settleHold };
  return untilLeft(() => land(ctx, request, options));
}

/** Undefined means land the next round; anything else ends the run. */
function afterLand(run: ShepherdRun, outcome: LandOutcome): Promise<LandOutcome | undefined> {
  return untilLeft(() => routeLanded(run, outcome));
}

async function routeLanded(run: ShepherdRun, outcome: LandOutcome): Promise<LandOutcome | undefined> {
  if (outcome.kind === "ci-failed") {
    const held = await heldByFrozenMain(run, outcome, run.freezeChecks++);
    if (held !== false) return held === true ? undefined : held;
    const staleBase = await staleBaseOf(run, outcome.headSha);
    if (staleBase !== undefined) return (await woken(run, "conflict", outcome.headSha, { staleBase })) ? undefined : ciFailedRoute(run, outcome);
    const wake = (payload: unknown) => woken(run, "review", outcome.headSha, payload);
    const accepted = await visualAcceptRoute(run, outcome, run.phases.visualSetCarry, wake, (stepId, prompt) => packetBeforeGate(packetRunOf(run), stepId, prompt));
    if (accepted !== NOT_OFFERED) return accepted;
    if (await woken(run, "ci-red", outcome.headSha, { failing: outcome.failing })) return undefined;
    return ciFailedRoute(run, outcome);
  }
  if (isSentBack(outcome)) return (await woken(run, "review", outcome.headSha, ownerSendBack(outcome))) ? undefined : unhandledSendBack(run, OWNER_SEND_BACK_KIND, outcome.headSha, outcome.detail);
  if (!isConflict(run, outcome)) return outcome;
  countConflictRound(run);
  return onConflict(run, outcome.headSha);
}

/**
 * A woken agent has already awaited its new head, so the caller goes straight to the next land round.
 * Every wake kind spends one repair budget per run, recorded as a step so a replay and a new head keep the count;
 * a wake past the budget asks the owner instead and leaves the round. A held run spends none, unless `heldRepair` lets it.
 * TP-4497: only a conflict wake, whose fixer merges main, keeps the merge-order reservation, and only while a fixer works.
 */
async function woken(run: ShepherdRun, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<boolean> {
  run.trail.woken = kind;
  if (kind !== "conflict") await releaseUnlandable(run);
  if (await awaitedPast(run, headSha)) return true;
  if (await heldRepair(run, kind, headSha, payload)) return true;
  if (!(await spendRepair(run.ctx, run.target, kind, headSha))) throw new LeaveLand(await unreserved(run, () => repairGate(run, kind, headSha, payload)));
  const outcome = await releasedUnlessWoken(run, run.phases.wake(run.ctx, { kind, ...run.target, round: run.state.round, headSha, payload }));
  return afterWake(run, kind, headSha, payload, outcome, (left) => new LeaveLand(left));
}

const packetRunOf = (run: ShepherdRun): PacketRun => ({ ctx: run.ctx, target: run.target, ownerGateReason: () => run.policy.ownerGateReason });

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
    recoveredInFlight: () => ctx.recoveredInFlight(),
    capability: (name) => ctx.capability(name),
    expireGates: (reason, isStale) => ctx.expireGates(reason, isStale),
    seed: (stepId, fn) => ctx.seed(stepId, fn),
    assisted: routingStuckBehind(run, () => run.lastCi?.headSha, askingOnlyOverMerge(run, recordingOverrides(followingApprovals(ctx, conflictCheckedGates(
      packetTriggering(packetRunOf(run), supersedingGates(ctx, supersede, () => (run.carried = undefined))), conflictCheck, leaveOnConflict), { ...setCarryOf(run, isVisualGate), reviewedMerge }),
      reviewedMerge, (override) => recordOverride(ctx, run.target, override)))),
    authorize: (stepId, request, options) => ctx.authorize(stepId, request, options),
    dispatch: async (stepId, template, options) => readDispatch(run, stepId, await ctx.dispatch(stepId, template, options)),
  };
}

async function readDispatch<R extends { data?: { result?: unknown } }>(run: ShepherdRun, stepId: string, done: R): Promise<R> {
  if (stepIdMatches("ci-wait", stepId)) await onCiRead(run, done.data?.result);
  if (stepIdMatches("update-branch", stepId)) onUpdated(run, done.data?.result);
  return done;
}

/** A reviewable head is reviewed once, then routed by the table; only the `merge` route reaches `land`'s merge decision. */
async function onCiRead(run: ShepherdRun, result: unknown): Promise<void> {
  const ci = CiSnapshotResult.safeParse(result);
  if (!ci.success) return;
  await recordHeadOrigin(run, ci.data);
  run.lastCi = noteRetarget(run, ci.data);
  expireStaleGates(run.ctx, ci.data.headSha);
  await expireOrder(run, ci.data.headSha);
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
    if (await takeRoute(run, routed)) return retakeOrder(run, headSha);
  }
}

/** True goes on to the merge decision, false reviews the same head again; every other route leaves this land round. */
async function takeRoute(run: ShepherdRun, routed: Routed): Promise<boolean> {
  const { route, headSha } = routed;
  const escalated = await countRound(run, routed);
  if (escalated) return routeEscalation(run, headSha, escalated);
  switch (route) {
    case "merge":
      return true;
    case "fresh-reviewer":
    case "retry-review":
    case "await-external":
    case "await-fixer":
      run.reviews.delete(headSha);
      if (route === "fresh-reviewer") run.fresh.add(headSha);
      return false;
    case "wake-fixer":
      if (routed.outcome === "FIX_FIRST") return sendBack(run, headSha, routed.verdict, (kind, payload) => woken(run, kind, headSha, payload));
      await releaseBeforeLeaving(run);
      throw new LeaveLand(await onConflict(run, headSha));
    case "end-run":
      throw new LeaveLand(endedOutcome(routed));
    case "update-branch":
    case "new-cycle":
    case "await-account":
      // A head behind a moved base lands as it stands, so only a MERGE verdict may take it to the merge decision.
      if (route === "update-branch" && behindAt(run.lastCi, headSha) && (routed.outcome === "MERGE" || routed.outcome === "carried" || run.lastCi?.baseMoved !== true)) return true;
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
  const request = { ...run.target, round: run.state.round, headSha, ...convergenceOf(run, headSha), ...fixRoundOf(run, headSha, cause, run.lastCi) };
  const billing = tappedReview(run);
  const verdict = await reviewKeepingSeatHold(run.seatHeld, headSha, (seatHeld) =>
    run.phases.review(billing, { ...request, ...(run.fresh.has(headSha) && { fresh: true }), cause, ...(seatHeld && { seatHeld }) }));
  return verdict.kind === "none" || verdict.headSha === headSha ? verdict : { kind: "none", cause: "no-verdict" };
}

/** The conflict round, its merge order and its fixer wakes (TP-4098, TP-4566). */
const onConflict = (run: ShepherdRun, headSha: string): Promise<LandOutcome | undefined> =>
  conflictRound(run, headSha, (payload) => woken(run, "conflict", headSha, payload));

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
    conflictCheckRoute(deps), conflictBaseRoute(deps), staleBaseRoute(deps), mergeMainRoute(deps),
    seatNoticeRoute(deps.now, deps.exitNotice, deps.sleep),
    ...freezeHoldRoutes(deps, wiring.mainRed?.freezes),
    ...g10ReleaseRoutes(deps, () => wiring.review?.twoMergeRelease),
    ...g10ReholdRoutes(deps, wiring.review?.carry),
    ...heldRepairRoutes(deps),
    ...visualPacketRoutes(deps),
    sendBackOfferRoute(deps), visualAcceptOfferRoute(deps),
    headOriginRoute(deps),
    reviewRefusedRoute(deps.now),
    autoPassRoute(deps.port, deps.now),
    ...diagnosisRoutes(deps),
  ];
}

export const DEFAULT_PHASES: ShepherdPhases = { wake: wakePhase, review: reviewPhase, visualSetCarry: () => configuredVisualSetCarry() };

/** The registered workflow; params `repo`, `pr` or `branch`, and `policy` as an `EffectivePolicy` JSON string. */
export function shepherdPrWorkflow(phases: ShepherdPhases = DEFAULT_PHASES): WorkflowDefinition {
  return defineWorkflow({ name: "shepherd-pr", steps: SHEPHERD_STEPS, run: classifyingFailures(async (ctx) => void (await shepherdPr(ctx, shepherdPrParams(ctx), phases))) });
}
