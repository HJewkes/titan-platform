import { OVERLAY_SHAPES, type AcceptedVerdict as PanelAcceptedVerdict, type AwaitVerdictInput, type PanelPolicy, type ReviewTarget, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "@titan-design/review-panel";
import type { OwnerOverride } from "./override-stats.js";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import type { StepClock } from "../workflows/deadline.js";
import { CORRECT_VERDICT_STEP, CorrectVerdictInputSchema, correctVerdict, type CorrectVerdictInput, type CorrectedResult } from "./correct-verdict.js";
import { reviewBrief, type CodewatchEvidence, type CodewatchReader } from "./codewatch-questions.js";
import { AWAIT_VERDICT_STEP, HEAD, awaitLateVerdict, parseAwaitVerdictInput, type AwaitVerdictTiming } from "./await-verdict.js";
import { awaitVerdictStep } from "./await-verdict-step.js";
import { ACCOUNT_STEPS, accountHeld, accountRoutes, billIntent, dispatchFor } from "./account-hold.js";
import { DEFAULT_ACCOUNT, type ReviewAccounts } from "./account-limit.js";
import { consoleTextOf, failureOf } from "./error-class.js";
import { seatVetoed } from "./external-review.js";
import { ownerIn } from "./seat-tie.js";
import { checkoutRootOf, dropCheckout, holdContextOf, thenDropCheckout } from "./review-member.js";
import { Intended, ReviewCauseSchema } from "./review-schemas.js";
import { MERGE_EVIDENCE_STEPS } from "./merge-evidence-gate.js";
import { MERGE_EVIDENCE_STEP, mergeEvidence, noFreezeStoreUntilTp523, registeredKind, type IsFrozen, type MergeEvidenceInput } from "./merge-facts.js";
import type { ShepherdDeps, ShepherdPhases } from "./phases.js";
import { PUBLISH_REVIEW_STEPS, publishReviewRoute } from "./publish-review.js";
import { DEFAULT_BROKER_DOWN_WAIT_MS, DEFAULT_BUSY_WAIT_MS, ReviewerAskTimedOut, ReviewerBrokerStillDown, busyWaits, clearReviewWait, notStarted, noteReviewWait, rosterUnread, startedSession, timedOutUnseen, whileBrokerBooting, whileBrokerBusy, whileRosterSlow, type BrokerDownTiming, type BusyTiming, type BusyWaits, type NotStarted } from "./review-wait.js";
import { CARRY_STEP, carryRoute, type CarryOptions } from "./tree-carry.js";
import { reviewerRoleFor, type ReviewerFacts, type ReviewerRoles } from "./reviewer-roles.js";
import { spawnFacts } from "./spawn-facts.js";
import type { TwoMergeMode } from "./g10-release.js";
import { chooseReviewer, lineageFor } from "./reviewer-choice.js";
import type { Lineage } from "./lineage.js";
import { isRepoKey } from "./seats.js";
import { REVIEW_REQUEST_STEPS, reviewPendingAt, reviewRequestRoute } from "./review-request.js";
import { SCOPED_REREVIEW_INPUT, scopeModeOf, scopedBriefFields, scopedResultFields, type ScopedRereviewWiring } from "./review-scope-round.js";
import { SCOPE_CHECK_STEPS, scopeCheckModeOf, scopeCheckRoute, type ScopeCheckWiring } from "./scope-check-round.js";
import { FIX_PROOF_STEPS, readFixProofAt } from "./fix-proof.js";
import { PROOF_WAIVER_STEPS, fixProofRoutes, proofStandingAt } from "./proof-waiver.js";
import type { MachineStopWatch } from "./machine-stop.js";
import type { VisualThreshold } from "./visual-delta-read.js";
import { REVIEW_STEP } from "./review-steps.js";
import { REVIEW_STOP_STEPS, reviewStopRoute } from "./review-stop.js";
import type { HoldMember, PanelMode } from "./review-panel-plan.js";
import { PANEL_STEPS, PROOF_PLAN_FIELDS, panelVerdictRoute, plannedPanel, proofPlanFields, type PanelOnPlan, type ProfileCheck } from "./review-panel-step.js";
import { CI_UNREAD_STEPS, ciUnreadRoute } from "./ci-unread.js";
import { LATE_VERDICT_STEP, SEAT_RECHECK_STEP, mergeVerdict, recheckSeat, takeVerdict } from "./take-verdict.js";
import { NO_REVIEWER_STEPS, noReviewerRoutes } from "./no-reviewer-hold.js";
import { notReviewed } from "./not-reviewed.js";
import { ciChecksAt } from "./green-checks.js";
import { heldMerge, recordsRecheck } from "./seat-recheck.js";
import { REVIEW_SHADOW_STEP, recordShadow, reviewShadowRoute, shadowOn } from "./review-shadow.js";
import { dispatchedRound } from "./review-round.js";
import { preflightOn, preflightPlan, preflightRefused, type ReviewWorkflowWiring } from "./review-preflight.js";

export const REVIEW_INTENT_STEP = "sh-review-intent";
export { AWAIT_VERDICT_STEP, LATE_VERDICT_STEP, REVIEW_STEP, mergeVerdict };
export const REVIEW_STEPS: readonly StepDeclaration[] = [
  ...FIX_PROOF_STEPS,
  ...PROOF_WAIVER_STEPS,
  { id: REVIEW_INTENT_STEP, kind: "dispatch" },
  { id: REVIEW_STEP, kind: "dispatch" },
  { id: AWAIT_VERDICT_STEP, kind: "dispatch" },
  { id: LATE_VERDICT_STEP, kind: "dispatch" },
  { id: CORRECT_VERDICT_STEP, kind: "dispatch" },
  { id: SEAT_RECHECK_STEP, kind: "dispatch" },
  ...MERGE_EVIDENCE_STEPS,
  { id: CARRY_STEP, kind: "dispatch" },
  ...PUBLISH_REVIEW_STEPS,
  ...ACCOUNT_STEPS,
  ...REVIEW_REQUEST_STEPS,
  ...REVIEW_STOP_STEPS,
  ...CI_UNREAD_STEPS,
  ...PANEL_STEPS,
  ...NO_REVIEWER_STEPS,
  ...SCOPE_CHECK_STEPS,
  { id: REVIEW_SHADOW_STEP, kind: "dispatch" },
];

export const DEFAULT_VERDICT_TIMEOUT_MS = 30 * 60_000;
/** How long a timed-out reviewer that has not exited is read again for its verdict. */
export const DEFAULT_LATE_VERDICT_MS = 10 * 60_000;
export const DEFAULT_SESSION_START_TIMEOUT_MS = 5 * 60_000;
/** How long Shepherd's own MERGE waits on a seat reviewer's WAIT at the same head before the round is held. */
const DEFAULT_SEAT_WAIT_MS = 30 * 60_000;
export { MAX_RESUME_FILL_TOKENS } from "./reviewer-choice.js";
const DEFAULT_POLL_MS = 30_000;
export { BUSY_FIRST_WAIT_MS, BUSY_LONGEST_WAIT_MS, DEFAULT_BUSY_WAIT_MS, ReviewerBrokerBusy, ReviewerBrokerDown } from "./review-wait.js";
export { DEFAULT_DETACH_GRACE_MS, DEFAULT_EXIT_GRACE_MS, awaitVerdict, parseAwaitVerdictInput } from "./await-verdict.js";
export { FIX_FIRST_TRUNCATED, MAX_FIX_FIRST_TEXT_CHARS, acceptVerdict } from "@titan-design/review-panel";
export type { AwaitVerdictInput, ReviewTarget, ReviewerAgent, ReviewerDispatch, ReviewerMessage, ReviewerReader };

export type ReviewInput = z.infer<typeof ReviewInputSchema>;

/** Which reviewer a head gets, recorded first so a repeat reads the same name and `at`; only a message written after `at` can be the verdict. */
export type ReviewIntent = z.infer<typeof ReviewIntentSchema>;
/** `refused` is the failure class of a dispatch the broker or port refused outright, which no retry at once can fix; `fixer` is preflight's refusal. */
type NoReview = { kind: "none"; reason: string; exhausted?: string; refused?: string; fixer?: { fingerprint: string; failure: string } };
export type ReviewIntentResult = ({ kind: "intent" } & ReviewIntent & Partial<PanelOnPlan>) | NoReview | NotStarted;
export type ReviewDispatchInput = z.infer<typeof ReviewDispatchInputSchema>;
export type ReviewDispatchResult = ({ kind: "dispatched"; agentId: string; sessionId: string; startedAt: number; codewatch?: CodewatchEvidence } & ReviewIntent & BusyWaits & { profile?: string }) | NoReview | NotStarted;

/** The package's accepted verdict, plus the seat disagreement only Shepherd records. */
type AcceptedVerdict = PanelAcceptedVerdict & {
  /** Set when a seat reviewer and Shepherd's own review gave opposite verdicts at this head (G10). */
  ownerOverride?: OwnerOverride;
};

/** Only a FIX_FIRST keeps the reviewer's words, because the implementer has to read them. */
export type AwaitVerdictResult = (AcceptedVerdict & { verdict: "MERGE" }) | (AcceptedVerdict & { verdict: "FIX_FIRST"; text: string; closer?: "yes" | "no" }) | { kind: "none"; reason?: string; notice?: string; resetsAt?: number };
const HeadSchema = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const ReviewTargetSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), pr: z.number().int().positive(), head: HeadSchema });
const ReviewInputSchema = ReviewTargetSchema.extend({ runId: z.string().min(1), fresh: z.boolean().optional(), cause: ReviewCauseSchema.optional(), ...PROOF_PLAN_FIELDS });
/**
 * `at` is epoch milliseconds. `agentId` is known only for a resume; a spawned agent gets its id from the broker. `external` starts nobody.
 * `account` is the Claude config directory the reviewer bills, set only when review accounts are wired.
 */
const ReviewIntentSchema = z.object({ head: HeadSchema, reviewer: z.string().min(1), at: z.number(), mode: z.enum(["spawn", "resume", "external"]), agentId: z.string().min(1).optional(), account: z.string().min(1).optional() });
/**
 * `fixFirsts` counts the run's earlier FIX_FIRST reviews; one or more makes the brief a re-review. `fixProof` is the raw result line the
 * sh-fix-proof step read at this head; `fixProofUnverified` says why that proof proves nothing, and the brief tells the reviewer it blocks.
 * `fixProofWaivedAt` is the head the owner's waiver names, and the brief says the fix-proof is waived only when that is the head under review.
 */
/** `shape` and `profile` are set only for a panel member other than correctness: its brief overlay and its planned profile. */
const ReviewDispatchInputSchema = ReviewTargetSchema.extend({
  intent: ReviewIntentSchema,
  runId: z.string().min(1).optional(),
  fixFirsts: z.number().int().positive().optional(),
  ownerBrief: z.boolean().optional(),
  fixProof: z.string().optional(),
  fixProofUnverified: z.enum(["error", "refused", "untrusted", "unread", "no-repro-test-only", "no-repro-non-source"]).optional(),
  fixProofWaivedAt: HeadSchema.optional(),
  workflowCiProof: z.object({ mergeBase: HeadSchema, head: HeadSchema }).optional(),
  shape: z.enum(OVERLAY_SHAPES).optional(),
  profile: z.string().min(1).optional(),
  convergence: z.literal(true).optional(),
  earlierFindings: z.array(z.object({ head: z.string(), text: z.string(), defectClass: z.string().optional() })).optional(),
}).extend(SCOPED_REREVIEW_INPUT);

type Timing = Pick<AwaitVerdictTiming, "now" | "sleep" | "pollMs">;

/**
 * Spawns or resumes the intent's reviewer, waiting out a broker that is down or busy; the watch row names a busy wait while it lasts, and `waits` keeps each one.
 * A timed-out ask may have landed, so it is `timed-out`, looked for like any ask, and never asked again blind (TP-2804).
 */
async function startReviewer(dispatch: ReviewerDispatch, intent: ReviewIntent, target: ReviewTarget, facts: ReviewerFacts, brief: string, timing: BusyTiming & BrokerDownTiming, signal: AbortSignal, waits: string[]): Promise<"asked" | "timed-out"> {
  const ask = () => (intent.mode === "resume" ? dispatch.resume(intent.reviewer, brief, signal) : dispatch.spawn(intent.reviewer, brief, target, facts, signal));
  const note = (text: string) => {
    waits.push(text);
    noteReviewWait(target.repo, target.pr, `waiting for reviewer admission (the broker has not started ${intent.reviewer}): ${text}`);
  };
  try {
    await whileBrokerBusy(timing, signal, note, () => whileBrokerBooting(timing, signal, ask));
    return "asked";
  } catch (error) {
    if (error instanceof ReviewerAskTimedOut) return "timed-out";
    throw error;
  } finally {
    clearReviewWait(target.repo, target.pr);
  }
}

/** A resumed reviewer is found by its agent id. A spawned one is the only agent under a name nobody held before. */
const holds = (intent: ReviewIntent) => (agent: ReviewerAgent) => (intent.agentId === undefined ? agent.name === intent.reviewer : agent.agentId === intent.agentId);

/** The intent only names an exited reviewer, so one that is no longer exited, or whose session wrote since, was resumed. */
const resumedSince = (intent: ReviewIntent) => (agent: ReviewerAgent) =>
  holds(intent)(agent) && (agent.presence !== "exited" || (agent.lastWrittenAt !== undefined && agent.lastWrittenAt >= intent.at));

function notStartedInTime(intent: ReviewIntent, rosterError: string | undefined): NoReview {
  const cause = rosterError === undefined ? "" : `; the last roster read failed: ${rosterError}`;
  return { kind: "none", reason: `reviewer ${intent.reviewer} did not start one session in time${cause}` };
}

export interface ReviewWiring extends ProfileCheck, ScopedRereviewWiring, ScopeCheckWiring {
  reader: ReviewerReader;
  /** Absent means no reviewer is dispatched and the owner gate decides. */
  dispatch?: ReviewerDispatch;
  /** Every generation, retired ones included, that proves a reviewer independent; absent means the dispatch's roster stands for it. */
  lineage?: () => Promise<Lineage>;
  /** Questions chosen by code for this PR and added to the reviewer brief. */
  questions?: (target: ReviewTarget) => Promise<readonly string[]>;
  /** The head's codewatch report questions, which go ahead of `questions`; absent, or undefined for a target, records nothing. */
  codewatch?: CodewatchReader;
  timeoutMs?: number;
  lateVerdictMs?: number;
  sessionStartTimeoutMs?: number;
  /** How long an own MERGE waits on a seat WAIT; absent means `DEFAULT_SEAT_WAIT_MS`. */
  seatWaitMs?: number;
  /** How long a busy broker is asked again before its refusal stands; absent means `DEFAULT_BUSY_WAIT_MS`. */
  busyWaitMs?: number;
  /** How long an unreachable broker is waited out before the run is held; absent means `DEFAULT_BROKER_DOWN_WAIT_MS`. */
  brokerDownWaitMs?: number;
  exitGraceMs?: number;
  detachGraceMs?: number;
  isFrozen?: IsFrozen;
  /** The App `shepherd/review` is posted as; merge facts count that check only from it. Absent means no app can satisfy it. */
  reviewAppId?: number;
  /** The profile each class of PR is spawned with; a spawned reviewer's profile travels with its verdict. */
  roles?: ReviewerRoles;
  /** How the `sh-carry` probe reaches git; absent means the system git against the factory's cache. */
  carry?: Omit<CarryOptions, "signal">;
  /** The reviewer accounts in failover order; absent means no account is checked before a spawn, and a limit holds the one default account. */
  accounts?: ReviewAccounts;
  /** The stops the spawn gate and the broker saw; absent means a silent reviewer is a timeout whatever the machine did. */
  machineStop?: MachineStopWatch;
  /** Absent means `off`: the intent records no panel plan and one reviewer is dispatched. */
  panel?: PanelMode;
  /** The panel a head is planned with; absent means `panelPolicyFor(roles)`. */
  panelPolicy?: PanelPolicy;
  /** A g10-adversary hold's own adversary member; absent plans none (`shepherd.gateReset.twoMergeRelease` off). */
  holdMember?: HoldMember;
  /** The adversary member's account (`review.adversaryConfigDir`); absent means the intent's. */
  adversaryDispatch?: ReviewerDispatch;
  /** `shepherd.gateReset.twoMergeRelease` other than off: whether two MERGEs release a g10-adversary hold or only record that they would. */
  twoMergeRelease?: TwoMergeMode;
  /** `shepherd.visualThreshold` for a repo, read per evidence step; absent, or undefined for a repo, measures nothing. */
  visualThreshold?: (repo: string) => VisualThreshold | undefined;
  /**
   * `review.workflow`: the intent records it. Under `shadow` each round then records what review-workflow would have done; under
   * `on:preflight` the intent refuses a head whose planned members could only be refused at dispatch. Absent means `off`.
   */
  workflow?: ReviewWorkflowWiring;
}

type Wired = ReviewWiring & { dispatch: ReviewerDispatch };
const brokerTiming = (deps: ShepherdDeps): Timing => ({ now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs ?? DEFAULT_POLL_MS });
const bootTiming = (deps: ShepherdDeps, wired: Wired): BrokerDownTiming => ({ ...brokerTiming(deps), brokerDownWaitMs: wired.brokerDownWaitMs ?? DEFAULT_BROKER_DOWN_WAIT_MS });

/** A broker that stayed down says so in the stored reason, from its budget alone; any other refusal carries only its class. */
const refusalOf = (error: unknown): string => (error instanceof ReviewerBrokerStillDown ? error.message : failureOf(error));

type BrokerStepBody<I, T> = (deps: ShepherdDeps, wired: Wired, input: I, signal: AbortSignal, repeat: boolean, clock?: StepClock) => Promise<T>;

/**
 * A malformed input fails the step. With no dispatch wired the step answers `none` at once, and a throw from its body is a refusal; either way the owner
 * gate decides. A refusal's text goes to the local console only, since the stored reason can reach a public PR.
 */
const brokerStep = <I, T extends object>(deps: ShepherdDeps, wiring: ReviewWiring | undefined, schema: z.ZodType<I>, body: BrokerStepBody<I, T>) =>
  async (raw: unknown, signal: AbortSignal, clock?: StepClock, repeat = false): Promise<T | NoReview> => {
    const input = schema.parse(raw);
    const dispatch = wiring?.dispatch;
    if (!dispatch) return { kind: "none", reason: "no reviewer dispatch is wired" };
    return body(deps, { ...wiring, dispatch }, input, signal, repeat, clock).catch((error: unknown) => {
      signal.throwIfAborted();
      const failure = refusalOf(error);
      console.warn(`shepherd: the reviewer dispatch was refused (${failure}): ${consoleTextOf(error)}`);
      return { kind: "none", reason: `the reviewer dispatch was refused: ${failure}`, refused: failure };
    });
  };

/**
 * The body of the sh-review-intent step. It asks the broker for nothing but the roster, so a repeat changes nothing; it records
 * why the head is reviewed and the account it bills. Shepherd's own review takes a seat's ask there, unless no account can bill it.
 */
const reviewIntent: BrokerStepBody<ReviewInput, ReviewIntentResult> = async (deps, wired, input, signal) => {
  const { dispatch, accounts } = wired;
  const timing = bootTiming(deps, wired);
  const budgetMs = wired.sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS;
  const roster = await whileRosterSlow(timing, signal, budgetMs, () => whileBrokerBooting(timing, signal, () => dispatch.roster())).catch(rosterUnread);
  if ("kind" in roster) return roster;
  const store = deps.store.get();
  const registration = store.byRun(input.runId);
  const lineage = await lineageFor(wired.lineage, registration, roster);
  const billed = billIntent(deps, accounts, input.runId, chooseReviewer(input, registration, roster, lineage, input.fresh), () => chooseReviewer(input, registration, roster, lineage, true));
  if ("exhausted" in billed) return { kind: "none", reason: "every review account is exhausted", exhausted: billed.exhausted };
  const plan = () => plannedPanel(deps, wired, { ...input, reviewer: billed.choice.reviewer, mode: billed.choice.mode }, roster);
  const preflight = billed.choice.mode !== "external" && preflightOn(wired.workflow) ? await preflightPlan(plan, wired.profileInstalled) : undefined;
  if (preflight?.kind === "none") return preflight;
  const requested = billed.choice.mode !== "external" && reviewPendingAt(registration, input.head) && store.takeReviewRequest(input.runId, input.head);
  const intent = { kind: "intent" as const, head: input.head, ...billed.choice, at: deps.now(), ...(billed.account && { account: billed.account }), ...(input.cause && { cause: input.cause }), ...(requested && { requested: true }), ...scopeModeOf(wired.scopedRereview), ...scopeCheckModeOf(wired.scopeCheck), ...(wired.workflow && { workflow: wired.workflow }) };
  if (billed.choice.mode === "external") return intent;
  return { ...intent, ...(preflight === undefined ? await plan() : preflight.planned) };
};

/** An adversary member runs under `review.adversaryConfigDir` when one is set; every other reviewer under the intent's account. */
const memberDispatch = (wired: Wired, shape: string | undefined): ReviewerDispatch | undefined => (shape === "adversary" ? wired.adversaryDispatch : undefined);

/**
 * The body of the sh-review step; `repeat` means a crash interrupted an earlier run. The brief is built from the target alone, so no registration text can
 * reach it, except an adversary's hold reason, which goes in fenced as data.
 * A reviewer an earlier run asked for keeps that run's session-start clock; one asked for again gets a fresh one.
 */
const dispatchReview: BrokerStepBody<ReviewDispatchInput, ReviewDispatchResult> = async (deps, wired, { intent, runId, fixFirsts, ownerBrief, fixProof, fixProofUnverified, fixProofWaivedAt, workflowCiProof, shape, profile, convergence, earlierFindings, scopedRereview, ...target }, signal, repeat, clock) => {
  const { dispatch, questions, codewatch, sessionStartTimeoutMs, busyWaitMs, roles } = wired;
  const timing = { ...bootTiming(deps, wired), timeoutMs: sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS, busyWaitMs: busyWaitMs ?? DEFAULT_BUSY_WAIT_MS };
  const roster = await whileBrokerBooting(timing, signal, () => dispatch.roster());
  // A held name was spawned by an earlier run, and a refused spawn holds none; a repeat that crashed before its resume landed asks again.
  const asked = roster.some(intent.mode === "resume" ? (agent) => repeat && resumedSince(intent)(agent) : holds(intent));
  const waits: string[] = [];
  const facts = { ...(await spawnFacts(deps, runId, intent, target, roles)), ...(profile !== undefined && { profile }) };
  const holdContext = shape === "adversary" ? holdContextOf(deps, runId) : undefined;
  const ciChecks = asked ? undefined : await ciChecksAt(deps.port, target.repo, target.pr, target.head);
  const asking = asked ? undefined : await reviewBrief({ ...target, checkoutRoot: checkoutRootOf(deps, shape), fixFirsts, ownerBrief, fixProof, fixProofUnverified, fixProofWaivedAt, workflowCiProof, testRule: deps.suiteRules?.reviewer, ...(ciChecks && { ciChecks }), ...(convergence && { convergence, earlierFindings }), ...scopedBriefFields(scopedRereview), ...(shape !== undefined && { shape }), ...(holdContext && { holdContext }) }, codewatch, questions);
  const outcome = asking && (await startReviewer(memberDispatch(wired, shape) ?? dispatchFor(wired.accounts, wired.dispatch, intent.account), intent, target, facts, asking.brief, timing, signal, waits).catch((error: unknown) => notStarted(error, waits)));
  if (typeof outcome === "object") {
    await dropCheckout(deps, target, shape);
    return outcome;
  }
  const { agent: started, rosterError } = await startedSession(() => dispatch.roster(), holds(intent), { ...timing, startedAt: asked ? clock?.firstStartedAtMs : undefined }, signal);
  if (!started) {
    await dropCheckout(deps, target, shape);
    // An unseen timed-out ask started nobody, so the review is retried now rather than held as no-reviewer.
    return outcome === "timed-out" ? timedOutUnseen(timing.timeoutMs, waits) : notStartedInTime(intent, rosterError);
  }
  const spawnedAs = profile ?? (roles && reviewerRoleFor(facts, roles));
  return { kind: "dispatched", ...intent, agentId: started.agentId, sessionId: started.sessionId, startedAt: deps.now(), ...(intent.mode === "spawn" && spawnedAs !== undefined && { profile: spawnedAs }), ...busyWaits(waits), ...(asking?.codewatch && { codewatch: asking.codewatch }), ...scopedResultFields(scopedRereview) };
};

/** The body of the sh-correct-verdict step, with the same session-start and busy budgets as sh-review; an adversary is resumed under its own account. */
const correctReviewer: BrokerStepBody<CorrectVerdictInput, CorrectedResult> = (deps, wired, input, signal, repeat) => {
  const { dispatch, sessionStartTimeoutMs, busyWaitMs } = wired;
  const timing = { ...brokerTiming(deps), timeoutMs: sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS, busyWaitMs: busyWaitMs ?? DEFAULT_BUSY_WAIT_MS };
  return correctVerdict(memberDispatch(wired, input.shape) ?? dispatch, input, timing, signal, repeat);
};

/** `codeRoute` for a body that must know it ran before: a first run is attempt 0 with no restarts, and only the recovery of an interrupted step raises either. */
function repeatAwareRoute<I>(match: string, now: () => number, fn: (input: I, signal: AbortSignal, clock: StepClock, repeat: boolean) => Promise<object>): StepRoute {
  const routeFor = (repeat: boolean) => codeRoute(match, now, (input: I, signal, clock) => fn(input, signal, clock, repeat));
  return { ...routeFor(false), runner: { run: (step) => routeFor(step.attempt > 0 || (step.restarts ?? 0) > 0).runner.run(step) } };
}

/** With no reader wired the verdict step answers `none` at once, so the owner gate decides. */
export const reviewRoutes = (deps: ShepherdDeps, wiring?: ReviewWiring): readonly StepRoute[] => {
  const timing = { ...brokerTiming(deps), timeoutMs: wiring?.timeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS, exitGraceMs: wiring?.exitGraceMs, detachGraceMs: wiring?.detachGraceMs };
  const seatWait = { ...brokerTiming(deps), timeoutMs: wiring?.seatWaitMs ?? DEFAULT_SEAT_WAIT_MS };
  return [
    ...fixProofRoutes(deps),
    codeRoute(REVIEW_INTENT_STEP, deps.now, brokerStep(deps, wiring, ReviewInputSchema, reviewIntent)),
    repeatAwareRoute(REVIEW_STEP, deps.now, brokerStep(deps, wiring, ReviewDispatchInputSchema, dispatchReview)),
    codeRoute(AWAIT_VERDICT_STEP, deps.now, seatVetoed(wiring, awaitVerdictStep(deps, wiring, timing), deps.now, seatWait, ownerIn(deps.store))),
    codeRoute(LATE_VERDICT_STEP, deps.now, (raw: unknown, signal, clock) => seatVetoed(wiring, (late: unknown, lateSignal) => lateVerdict(deps, wiring, parseAwaitVerdictInput(late), lateSignal, clock.firstStartedAtMs), deps.now, seatWait, ownerIn(deps.store))(raw, signal)),
    repeatAwareRoute(CORRECT_VERDICT_STEP, deps.now, brokerStep(deps, wiring, CorrectVerdictInputSchema, correctReviewer)),
    codeRoute(SEAT_RECHECK_STEP, deps.now, seatVetoed(wiring, async (raw: unknown) => heldMerge(raw), deps.now, seatWait, ownerIn(deps.store))),
    codeRoute(MERGE_EVIDENCE_STEP, deps.now, async (input: MergeEvidenceInput, signal: AbortSignal) => mergeEvidence(deps.port, input, wiring?.isFrozen ?? noFreezeStoreUntilTp523, registeredKind(deps.store, input.runId), { sleep: (ms) => deps.sleep(ms, signal) }, { reviewAppId: wiring?.reviewAppId, threshold: wiring?.visualThreshold?.(input.repo) })),
    carryRoute(deps.now, wiring?.carry),
    publishReviewRoute(deps),
    ...accountRoutes(deps, wiring?.accounts),
    reviewRequestRoute(deps),
    reviewStopRoute(deps, wiring?.machineStop),
    ciUnreadRoute(deps.now),
    panelVerdictRoute(deps),
    ...noReviewerRoutes(deps, wiring?.accounts?.alert),
    scopeCheckRoute(deps.now),
    reviewShadowRoute(deps.now, wiring),
  ];
};

/** With no dispatch wired there is no roster to tell an exited reviewer, so the step answers `none` at once. */
async function lateVerdict(deps: ShepherdDeps, wiring: ReviewWiring | undefined, input: AwaitVerdictInput, signal: AbortSignal, startedAt: number | undefined): Promise<AwaitVerdictResult> {
  const dispatch = wiring?.dispatch;
  if (!dispatch) return { kind: "none" };
  const timing = { ...brokerTiming(deps), timeoutMs: wiring.lateVerdictMs ?? DEFAULT_LATE_VERDICT_MS, startedAt };
  const exited = async () => (await dispatch.roster()).every((agent) => agent.agentId !== input.reviewerAgentId || agent.presence === "exited");
  return thenDropCheckout(deps, input, () => awaitLateVerdict(wiring.reader, exited, input, timing, signal), () => true);
}

/**
 * Read the head's fix-proof result, record which reviewer this head gets, start or adopt it, wait for its verdict, and take a
 * MERGE through the evidence step. A vacuous or test-less proof ends the review as NO_REPRO before any reviewer is started, unless
 * the owner waived it at this head: then the review proceeds and its MERGE goes only to the owner gate. An
 * unverified one goes to the reviewer marked unverified, and its MERGE records that standing but keeps the policy's grant (decision 303).
 * The resolver comes from the verdict step and the dispatched reviewer from the dispatch step, so a mismatch between them gates.
 * An intent recorded under `review.panel` on runs the panel; one recorded with no plan, before the flag or under off or shadow, runs one reviewer.
 */
export const reviewPhase: ShepherdPhases["review"] = async (ctx, request) => {
  const target: ReviewTarget = { repo: request.repo, pr: request.pr, head: request.headSha };
  const proof = await readFixProofAt(ctx, target);
  const gated = await proofStandingAt(ctx, target.head, proof);
  if ("ended" in gated) return gated.ended;
  const { standing } = gated;
  if (request.seatHeld?.head === target.head && recordsRecheck(ctx, target.head)) return recheckSeat(ctx, target, request.seatHeld, standing);
  const intent = await step(ctx, `${REVIEW_INTENT_STEP}:${target.head}`, { ...target, runId: ctx.runId, ...(request.fresh && { fresh: true }), ...(request.cause && { cause: request.cause }), ...proofPlanFields(proof, target.head, standing) }, Intended);
  if (intent.kind !== "intent") return typeof intent.exhausted === "string" ? accountHeld(ctx, target, { account: intent.exhausted }) : (preflightRefused(ctx, target, intent) ?? notReviewed(ctx, target, intent));
  if (intent.mode === "external") return takeVerdict(ctx, target, { ...target, external: intent.reviewer }, undefined, DEFAULT_ACCOUNT, standing);
  const { dispatched, verdict } = await dispatchedRound(ctx, request, { target, proof, standing, intent });
  if (shadowOn(intent)) await recordShadow(ctx, { target, proof, intent, dispatched, verdict });
  return verdict;
};
