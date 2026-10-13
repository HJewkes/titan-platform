import type { AgentIdentity } from "@titan-design/authority";
import { OVERLAY_SHAPES, type AcceptedVerdict as PanelAcceptedVerdict, type AwaitVerdictInput, type PanelPolicy, type ReviewTarget, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "@titan-design/review-panel";
import type { OwnerOverride } from "./override-stats.js";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { join } from "node:path";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { CORRECT_VERDICT_STEP, CorrectVerdictInputSchema, correctVerdict, type CorrectVerdictInput, type CorrectedResult } from "./correct-verdict.js";
import { reviewBrief, type CodewatchEvidence, type CodewatchReader } from "./codewatch-questions.js";
import { AWAIT_VERDICT_STEP, HEAD, awaitLateVerdict, awaitVerdict, bounded, parseAwaitVerdictInput, type AwaitVerdictTiming } from "./await-verdict.js";
import { ACCOUNT_STEPS, accountHeld, accountRoutes, billIntent, dispatchFor } from "./account-hold.js";
import { DEFAULT_ACCOUNT, type ReviewAccounts } from "./account-limit.js";
import { consoleTextOf, failureOf } from "./error-class.js";
import { awaitExternalVerdict, isExternalVerdictInput, seatVetoed } from "./external-review.js";
import { removeReviewCheckout, reviewCheckoutRoot } from "./review-checkout.js";
import { Dispatched, Intended, ReviewCauseSchema } from "./review-schemas.js";
import { MERGE_EVIDENCE_STEPS } from "./merge-evidence-gate.js";
import { MERGE_EVIDENCE_STEP, mergeEvidence, noFreezeStoreUntilTp523, registeredKind, type IsFrozen, type MergeEvidenceInput } from "./merge-facts.js";
import type { ShepherdDeps, ShepherdPhases, Verdict } from "./phases.js";
import { PUBLISH_REVIEW_STEPS, publishReviewRoute } from "./publish-review.js";
import { DEFAULT_BUSY_WAIT_MS, busyWaits, clearReviewWait, notStarted, noteReviewWait, startedSession, whileBrokerBusy, whileBrokerDown, type BusyTiming, type BusyWaits, type NotStarted } from "./review-wait.js";
import { CARRY_STEP, carryRoute, type CarryOptions } from "./tree-carry.js";
import { reviewerRoleFor, type ReviewerFacts, type ReviewerRoles } from "./reviewer-roles.js";
import { spawnFacts } from "./spawn-facts.js";
import { withReviewerProfile } from "./g10-release.js";
import { chooseReviewer } from "./reviewer-choice.js";
import { isRepoKey } from "./seats.js";
import { REVIEW_REQUEST_STEPS, reviewPendingAt, reviewRequestRoute } from "./review-request.js";
import { fixFirstCount } from "./wake-brief.js";
import { FIX_PROOF_STEP, FIX_PROOF_STEPS, FixProofReadSchema, fixProofRoute, fixProofVerdict } from "./fix-proof.js";
import type { MachineStopWatch } from "./machine-stop.js";
import { REVIEW_STEP } from "./review-steps.js";
import { REVIEW_STOP_STEPS, reviewStopRoute } from "./review-stop.js";
import { withoutPlan, type PanelMode } from "./review-panel-plan.js";
import { PANEL_STEPS, panelOn, panelReview, panelVerdictRoute, plannedPanel, type MemberBase, type PanelOnPlan } from "./review-panel-step.js";
import { LATE_VERDICT_STEP, SEAT_RECHECK_STEP, asksOwnerBrief, mergeVerdict, recheckSeat, takeVerdict } from "./take-verdict.js";
import { NO_REVIEWER_STEPS, noReviewerHeld, noReviewerRoutes } from "./no-reviewer-hold.js";
import { heldMerge, recordsRecheck } from "./seat-recheck.js";

export const REVIEW_INTENT_STEP = "sh-review-intent";
export { REVIEW_STEP };
export { AWAIT_VERDICT_STEP };
export { LATE_VERDICT_STEP, mergeVerdict };
export const REVIEW_STEPS: readonly StepDeclaration[] = [
  ...FIX_PROOF_STEPS,
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
  ...PANEL_STEPS,
  ...NO_REVIEWER_STEPS,
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
/** `refused` is the failure class of a dispatch the broker or port refused outright, which no retry at once can fix. */
type NoReview = { kind: "none"; reason: string; exhausted?: string; refused?: string };
export type ReviewIntentResult = ({ kind: "intent" } & ReviewIntent & Partial<PanelOnPlan>) | NoReview;
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
const ReviewInputSchema = ReviewTargetSchema.extend({ runId: z.string().min(1), fresh: z.boolean().optional(), cause: ReviewCauseSchema.optional() });
/**
 * `at` is epoch milliseconds. `agentId` is known only for a resume; a spawned agent gets its id from the broker. `external` starts nobody.
 * `account` is the Claude config directory the reviewer bills, set only when review accounts are wired.
 */
const ReviewIntentSchema = z.object({ head: HeadSchema, reviewer: z.string().min(1), at: z.number(), mode: z.enum(["spawn", "resume", "external"]), agentId: z.string().min(1).optional(), account: z.string().min(1).optional() });
/** `fixFirsts` counts the run's earlier FIX_FIRST reviews; one or more makes the brief a re-review. `fixProof` is the raw result line the sh-fix-proof step read at this head. */
/** `shape` and `profile` are set only for a panel member other than correctness: its brief overlay and its planned profile. */
const ReviewDispatchInputSchema = ReviewTargetSchema.extend({
  intent: ReviewIntentSchema,
  runId: z.string().min(1).optional(),
  fixFirsts: z.number().int().positive().optional(),
  ownerBrief: z.boolean().optional(),
  fixProof: z.string().optional(),
  shape: z.enum(OVERLAY_SHAPES).optional(),
  profile: z.string().min(1).optional(),
});

type Timing = Pick<AwaitVerdictTiming, "now" | "sleep" | "pollMs">;

/** Spawns or resumes the intent's reviewer, waiting out a broker that is down or busy; the watch row names a busy wait while it lasts, and `waits` keeps each one. */
async function startReviewer(dispatch: ReviewerDispatch, intent: ReviewIntent, target: ReviewTarget, facts: ReviewerFacts, brief: string, timing: BusyTiming & Timing, signal: AbortSignal, waits: string[]): Promise<void> {
  const ask = () => (intent.mode === "resume" ? dispatch.resume(intent.reviewer, brief) : dispatch.spawn(intent.reviewer, brief, target, facts));
  const note = (text: string) => {
    waits.push(text);
    noteReviewWait(target.repo, target.pr, `waiting for reviewer admission (the broker has not started ${intent.reviewer}): ${text}`);
  };
  try {
    await whileBrokerBusy(timing, signal, note, () => whileBrokerDown(timing, signal, ask));
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

export interface ReviewWiring {
  reader: ReviewerReader;
  /** Absent means no reviewer is dispatched and the owner gate decides. */
  dispatch?: ReviewerDispatch;
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
}

type Wired = ReviewWiring & { dispatch: ReviewerDispatch };
const brokerTiming = (deps: ShepherdDeps): Timing => ({ now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs ?? DEFAULT_POLL_MS });

type BrokerStepBody<I, T> = (deps: ShepherdDeps, wired: Wired, input: I, signal: AbortSignal, repeat: boolean) => Promise<T>;

/**
 * A malformed input fails the step. With no dispatch wired the step answers `none` at once, and a throw from its body is a refusal; either way the owner
 * gate decides. A refusal's text goes to the local console only, since the stored reason can reach a public PR.
 */
const brokerStep = <I, T extends object>(deps: ShepherdDeps, wiring: ReviewWiring | undefined, schema: z.ZodType<I>, body: BrokerStepBody<I, T>) =>
  async (raw: unknown, signal: AbortSignal, repeat = false): Promise<T | NoReview> => {
    const input = schema.parse(raw);
    const dispatch = wiring?.dispatch;
    if (!dispatch) return { kind: "none", reason: "no reviewer dispatch is wired" };
    return body(deps, { ...wiring, dispatch }, input, signal, repeat).catch((error: unknown) => {
      signal.throwIfAborted();
      const failure = failureOf(error);
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
  const roster = await whileBrokerDown(brokerTiming(deps), signal, () => dispatch.roster());
  const store = deps.store.get();
  const registration = store.byRun(input.runId);
  const billed = billIntent(deps, accounts, input.runId, chooseReviewer(input, registration, roster, input.fresh), () => chooseReviewer(input, registration, roster, true));
  if ("exhausted" in billed) return { kind: "none", reason: "every review account is exhausted", exhausted: billed.exhausted };
  const requested = billed.choice.mode !== "external" && reviewPendingAt(registration, input.head) && store.takeReviewRequest(input.runId, input.head);
  const intent = { kind: "intent" as const, head: input.head, ...billed.choice, at: deps.now(), ...(billed.account && { account: billed.account }), ...(input.cause && { cause: input.cause }), ...(requested && { requested: true }) };
  return billed.choice.mode === "external" ? intent : { ...intent, ...(await plannedPanel(deps, wired, { ...input, reviewer: intent.reviewer, mode: intent.mode }, roster)) };
};

type MemberShape = (typeof OVERLAY_SHAPES)[number];

/** A panel member other than correctness checks out under its shape's dir, since each reviewer removes its own run dir when it is done. */
const checkoutRootOf = (deps: ShepherdDeps, shape?: MemberShape): string => {
  const root = deps.reviewCheckouts?.root ?? reviewCheckoutRoot();
  return shape === undefined ? root : join(root, shape);
};

/** Removes the run's checkout dir; the reviewer is told to, but a reviewer that failed or timed out never does, and a verdict must not depend on it. */
async function dropCheckout(deps: ShepherdDeps, target: ReviewTarget, shape?: MemberShape): Promise<void> {
  await removeReviewCheckout(checkoutRootOf(deps, shape), target, deps.reviewCheckouts?.remove);
}

/**
 * Removes the checkout once the reviewer is finished with it: when `work` returns and `finished` says so. A throw (an abort at
 * shutdown, say) leaves it, because the reviewer outlives the step and a replay waits on it; the sweep is the backstop.
 */
async function thenDropCheckout<T>(deps: ShepherdDeps, target: ReviewTarget, work: () => Promise<T>, finished: (result: T) => boolean, shape?: MemberShape): Promise<T> {
  const result = await work();
  if (finished(result)) await dropCheckout(deps, target, shape);
  return result;
}

/** The body of the sh-review step; `repeat` means a crash interrupted an earlier run. The brief is built from the target alone, so no registration text can reach it. */
const dispatchReview: BrokerStepBody<ReviewDispatchInput, ReviewDispatchResult> = async (deps, wired, { intent, runId, fixFirsts, ownerBrief, fixProof, shape, profile, ...target }, signal, repeat) => {
  const { dispatch, questions, codewatch, sessionStartTimeoutMs, busyWaitMs, roles } = wired;
  const timing = { ...brokerTiming(deps), timeoutMs: sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS, busyWaitMs: busyWaitMs ?? DEFAULT_BUSY_WAIT_MS };
  const roster = await whileBrokerDown(timing, signal, () => dispatch.roster());
  // A held name was spawned by an earlier run, and a refused spawn holds none; a repeat that crashed before its resume landed asks again.
  const asked = roster.some(intent.mode === "resume" ? (agent) => repeat && resumedSince(intent)(agent) : holds(intent));
  const waits: string[] = [];
  const facts = { ...(await spawnFacts(deps, runId, intent, target, roles)), ...(profile !== undefined && { profile }) };
  const asking = asked ? undefined : await reviewBrief({ ...target, checkoutRoot: checkoutRootOf(deps, shape), fixFirsts, ownerBrief, fixProof, testRule: deps.suiteRules?.reviewer, ...(shape !== undefined && { shape }) }, codewatch, questions);
  if (asking) {
    const refused = await startReviewer(dispatchFor(wired.accounts, wired.dispatch, intent.account), intent, target, facts, asking.brief, timing, signal, waits).then(() => undefined, (error: unknown) => notStarted(error, waits));
    if (refused) {
      await dropCheckout(deps, target, shape);
      return refused;
    }
  }
  const { agent: started, rosterError } = await startedSession(() => dispatch.roster(), holds(intent), timing, signal);
  if (!started) {
    await dropCheckout(deps, target, shape);
    return notStartedInTime(intent, rosterError);
  }
  const spawnedAs = profile ?? (roles && reviewerRoleFor(facts, roles));
  return { kind: "dispatched", ...intent, agentId: started.agentId, sessionId: started.sessionId, startedAt: deps.now(), ...(intent.mode === "spawn" && spawnedAs !== undefined && { profile: spawnedAs }), ...busyWaits(waits), ...(asking?.codewatch && { codewatch: asking.codewatch }) };
};

/** The body of the sh-correct-verdict step, with the same session-start and busy budgets as sh-review. */
const correctReviewer: BrokerStepBody<CorrectVerdictInput, CorrectedResult> = (deps, { dispatch, sessionStartTimeoutMs, busyWaitMs }, input, signal, repeat) => {
  const timing = { ...brokerTiming(deps), timeoutMs: sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS, busyWaitMs: busyWaitMs ?? DEFAULT_BUSY_WAIT_MS };
  return correctVerdict(dispatch, input, timing, signal, repeat);
};

/** `codeRoute` for a body that must know it ran before: a first run is attempt 0, and only the recovery of an interrupted step raises it. */
function repeatAwareRoute<I>(match: string, now: () => number, fn: (input: I, signal: AbortSignal, repeat: boolean) => Promise<object>): StepRoute {
  const routeFor = (repeat: boolean) => codeRoute(match, now, (input: I, signal) => fn(input, signal, repeat));
  return { ...routeFor(false), runner: { run: (step) => routeFor(step.attempt > 0).runner.run(step) } };
}

/** A panel member's await names its shape, so its own checkout is the one removed. */
const MemberShapeRead = z.looseObject({ shape: z.enum(OVERLAY_SHAPES).optional() });

/** With no reader wired the verdict step answers `none` at once, so the owner gate decides. */
export const reviewRoutes = (deps: ShepherdDeps, wiring?: ReviewWiring): readonly StepRoute[] => {
  const timing = { ...brokerTiming(deps), timeoutMs: wiring?.timeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS, exitGraceMs: wiring?.exitGraceMs, detachGraceMs: wiring?.detachGraceMs };
  const run = async (raw: unknown, signal: AbortSignal): Promise<AwaitVerdictResult> => {
    if (isExternalVerdictInput(raw)) return wiring?.dispatch ? bounded(await awaitExternalVerdict(wiring.dispatch.roster, wiring.reader, raw, timing, signal)) : { kind: "none" };
    const input = parseAwaitVerdictInput(raw);
    if (!wiring) return { kind: "none" };
    const { reader, dispatch } = wiring;
    const work = () => awaitVerdict(reader, input, timing, signal, dispatch && (() => dispatch.roster()));
    return thenDropCheckout(deps, input, work, (result) => result.kind === "verdict", MemberShapeRead.parse(raw).shape);
  };
  const isFrozen = wiring?.isFrozen ?? noFreezeStoreUntilTp523;
  const seatWait = { ...brokerTiming(deps), timeoutMs: wiring?.seatWaitMs ?? DEFAULT_SEAT_WAIT_MS };
  return [
    fixProofRoute(deps),
    codeRoute(REVIEW_INTENT_STEP, deps.now, brokerStep(deps, wiring, ReviewInputSchema, reviewIntent)),
    repeatAwareRoute(REVIEW_STEP, deps.now, brokerStep(deps, wiring, ReviewDispatchInputSchema, dispatchReview)),
    codeRoute(AWAIT_VERDICT_STEP, deps.now, seatVetoed(wiring, run, deps.now, seatWait)),
    codeRoute(LATE_VERDICT_STEP, deps.now, seatVetoed(wiring, (raw: unknown, signal) => lateVerdict(deps, wiring, parseAwaitVerdictInput(raw), signal), deps.now, seatWait)),
    repeatAwareRoute(CORRECT_VERDICT_STEP, deps.now, brokerStep(deps, wiring, CorrectVerdictInputSchema, correctReviewer)),
    codeRoute(SEAT_RECHECK_STEP, deps.now, seatVetoed(wiring, async (raw: unknown) => heldMerge(raw), deps.now, seatWait)),
    codeRoute(MERGE_EVIDENCE_STEP, deps.now, async (input: MergeEvidenceInput, signal: AbortSignal) => mergeEvidence(deps.port, input, isFrozen, registeredKind(deps.store, input.runId), { sleep: (ms) => deps.sleep(ms, signal) }, wiring?.reviewAppId)),
    carryRoute(deps.now, wiring?.carry),
    publishReviewRoute(deps),
    ...accountRoutes(deps, wiring?.accounts),
    reviewRequestRoute(deps),
    reviewStopRoute(deps, wiring?.machineStop),
    panelVerdictRoute(deps),
    ...noReviewerRoutes(deps, wiring?.accounts?.alert),
  ];
};

/** With no dispatch wired there is no roster to tell an exited reviewer, so the step answers `none` at once. */
async function lateVerdict(deps: ShepherdDeps, wiring: ReviewWiring | undefined, input: AwaitVerdictInput, signal: AbortSignal): Promise<AwaitVerdictResult> {
  const dispatch = wiring?.dispatch;
  if (!dispatch) return { kind: "none" };
  const timing = { ...brokerTiming(deps), timeoutMs: wiring.lateVerdictMs ?? DEFAULT_LATE_VERDICT_MS };
  const exited = async () => (await dispatch.roster()).every((agent) => agent.agentId !== input.reviewerAgentId || agent.presence === "exited");
  return thenDropCheckout(deps, input, () => awaitLateVerdict(wiring.reader, exited, input, timing, signal), () => true);
}

/**
 * A busy broker that started nobody retries the review. A refusal holds the run as no-reviewer rather than counting a failed
 * round, so a repo with no usable reviewer never reaches approve-merge unreviewed (TP-2446). Any other none is a round with no verdict.
 */
function notDispatched(ctx: WorkflowContext, target: ReviewTarget, dispatched: Readonly<Record<string, unknown>>): Promise<Verdict> | Verdict {
  if (dispatched.notStarted === true) return { kind: "none", cause: "not-started" };
  if (typeof dispatched.refused === "string") return noReviewerHeld(ctx, target, dispatched.refused);
  return { kind: "none", cause: "no-verdict" };
}

/**
 * Read the head's fix-proof result, record which reviewer this head gets, start or adopt it, wait for its verdict, and take a
 * MERGE through the evidence step. A vacuous or test-less proof ends the review as NO_REPRO before any reviewer is started.
 * The resolver comes from the verdict step and the dispatched reviewer from the dispatch step, so a mismatch between them gates.
 * An intent recorded under `review.panel` on runs the panel; one recorded with no plan, before the flag or under off or shadow, runs one reviewer.
 */
export const reviewPhase: ShepherdPhases["review"] = async (ctx, request) => {
  const target: ReviewTarget = { repo: request.repo, pr: request.pr, head: request.headSha };
  if (request.seatHeld?.head === target.head && recordsRecheck(ctx, target.head)) return recheckSeat(ctx, target, request.seatHeld);
  const proof = await step(ctx, `${FIX_PROOF_STEP}:${target.head}`, { repo: target.repo, head: target.head, runId: ctx.runId }, FixProofReadSchema);
  const noRepro = fixProofVerdict(proof, target.head);
  if (noRepro) return noRepro;
  const intent = await step(ctx, `${REVIEW_INTENT_STEP}:${target.head}`, { ...target, runId: ctx.runId, ...(request.fresh && { fresh: true }), ...(request.cause && { cause: request.cause }) }, Intended);
  if (intent.kind !== "intent") return typeof intent.exhausted === "string" ? accountHeld(ctx, target, { account: intent.exhausted }) : { kind: "none", cause: "no-verdict" };
  if (intent.mode === "external") return takeVerdict(ctx, target, { ...target, external: intent.reviewer }, undefined);
  const fixFirsts = fixFirstCount(ctx);
  const base: MemberBase = { ...target, runId: ctx.runId, ...(fixFirsts > 0 && { fixFirsts }), ...(proof.kind === "result" && { fixProof: proof.line }) };
  const dispatched = await step(ctx, `${REVIEW_STEP}:${target.head}`, { ...target, runId: ctx.runId, intent: withoutPlan(intent), ...(fixFirsts > 0 && { fixFirsts }), ...(asksOwnerBrief(ctx) && { ownerBrief: true }), ...(base.fixProof !== undefined && { fixProof: base.fixProof }) }, Dispatched);
  if (dispatched.kind !== "dispatched") return notDispatched(ctx, target, dispatched);
  const dispatchedReviewer: AgentIdentity = { agentId: dispatched.agentId, sessionId: dispatched.sessionId };
  const awaiting: AwaitVerdictInput & { reviewerProfile?: string } = {
    ...target,
    reviewerAgentId: dispatched.agentId,
    reviewerSessionId: dispatched.sessionId,
    dispatchedAt: dispatched.at,
    ...(dispatched.startedAt !== undefined && { startedAt: dispatched.startedAt }),
    ...(dispatched.profile !== undefined && { reviewerProfile: dispatched.profile }),
  };
  const account = typeof intent.account === "string" ? intent.account : DEFAULT_ACCOUNT;
  const reviewed = panelOn(intent) ? await panelReview(ctx, intent, base, awaiting, dispatchedReviewer, account) : await takeVerdict(ctx, target, awaiting, dispatchedReviewer, account);
  return withReviewerProfile(reviewed, dispatched.profile);
};
