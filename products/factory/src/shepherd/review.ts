import type { AgentIdentity } from "@titan-design/authority";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { deadline } from "../workflows/deadline.js";
import { codeRoute, step } from "../workflows/land.js";
import { freshReviewerBase } from "./cleanup.js";
import { reviewBrief, type CodewatchEvidence, type CodewatchReader } from "./codewatch-questions.js";
import { HEAD, awaitLateVerdict, awaitVerdict, bounded, parseAwaitVerdictInput, type AwaitVerdictTiming } from "./await-verdict.js";
import { awaitExternalVerdict, externalReviewer, isExternalVerdictInput, seatVetoed } from "./external-review.js";
import { MERGE_EVIDENCE_STEP, mergeEvidence, noFreezeStoreUntilTp523, registeredKind, type IsFrozen, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { ShepherdDeps, ShepherdPhases, Verdict } from "./phases.js";
import { EffectivePolicySchema, MERGE_ON_GREEN_GRANT, OWNER_GATE_POLICY } from "./policy.js";
import { DEFAULT_BUSY_WAIT_MS, busyWaits, clearReviewWait, notStarted, noteReviewWait, whileBrokerBusy, type BusyTiming, type BusyWaits, type NotStarted } from "./review-wait.js";
import { CARRY_STEP, carryRoute, type CarryOptions } from "./tree-carry.js";
import { isRepoKey } from "./seats.js";
import type { Registration } from "./store.js";
import { FIX_FIRST_STEP } from "./wake-brief.js";

export const REVIEW_INTENT_STEP = "sh-review-intent";
export const REVIEW_STEP = "sh-review";
export const AWAIT_VERDICT_STEP = "sh-await-verdict";
export const LATE_VERDICT_STEP = "sh-late-verdict";
export const REVIEW_STEPS: readonly StepDeclaration[] = [
  { id: REVIEW_INTENT_STEP, kind: "dispatch" },
  { id: REVIEW_STEP, kind: "dispatch" },
  { id: AWAIT_VERDICT_STEP, kind: "dispatch" },
  { id: LATE_VERDICT_STEP, kind: "dispatch" },
  { id: MERGE_EVIDENCE_STEP, kind: "dispatch" },
  { id: CARRY_STEP, kind: "dispatch" },
];

export const DEFAULT_VERDICT_TIMEOUT_MS = 30 * 60_000;
/** How long a timed-out reviewer that has not exited is read again for its verdict. */
export const DEFAULT_LATE_VERDICT_MS = 10 * 60_000;
export const DEFAULT_SESSION_START_TIMEOUT_MS = 5 * 60_000;
/** A standing reviewer holding this much context or more is not resumed. */
export const MAX_RESUME_FILL_TOKENS = 300_000;
const DEFAULT_POLL_MS = 30_000;
export { BUSY_FIRST_WAIT_MS, BUSY_LONGEST_WAIT_MS, DEFAULT_BUSY_WAIT_MS, ReviewerBrokerBusy } from "./review-wait.js";
export { DEFAULT_DETACH_GRACE_MS, DEFAULT_EXIT_GRACE_MS, FIX_FIRST_TRUNCATED, MAX_FIX_FIRST_TEXT_CHARS, acceptVerdict, awaitVerdict, parseAwaitVerdictInput } from "./await-verdict.js";

export interface ReviewTarget {
  repo: string;
  pr: number;
  head: string;
}

export type ReviewInput = z.infer<typeof ReviewInputSchema>;

/** One roster row, as the dispatch port reports it. */
export interface ReviewerAgent {
  name: string;
  agentId: string;
  /** Empty until the agent's session has started. */
  sessionId: string;
  /** `live`, `detached` or `exited`. */
  presence: string;
  spawnedBy: string | null;
  /** The agent this one took over from, null for none; absent means the port holds no lineage, and such an agent is never resumed. */
  predecessor?: string | null;
  /** Context tokens the session holds; absent means unknown, and an unknown fill is never resumed. */
  fillTokens?: number;
  /** Epoch milliseconds of the latest write to the session's transcript, which a resume appends to; absent means unknown. */
  lastWrittenAt?: number;
}

/** The port throws this when the broker cannot be reached: nothing was asked of it, so asking again is safe. */
export class ReviewerBrokerDown extends Error {
  override readonly name = "ReviewerBrokerDown";
}

/** How Shepherd starts a reviewer; a throw from `spawn` or `resume` other than `ReviewerBrokerDown` or `ReviewerBrokerBusy` is a refusal. */
export interface ReviewerDispatch {
  roster(): Promise<readonly ReviewerAgent[]>;
  /** `target` names the repo whose checkout the reviewer starts in. */
  spawn(name: string, brief: string, target: ReviewTarget): Promise<void>;
  resume(name: string, brief: string): Promise<void>;
}

/** Which reviewer a head gets, recorded first so a repeat reads the same name and `at`; only a message written after `at` can be the verdict. */
export type ReviewIntent = z.infer<typeof ReviewIntentSchema>;
type NoReview = { kind: "none"; reason: string };
export type ReviewIntentResult = ({ kind: "intent" } & ReviewIntent) | NoReview;
export type ReviewDispatchInput = z.infer<typeof ReviewDispatchInputSchema>;
export type ReviewDispatchResult = ({ kind: "dispatched"; agentId: string; sessionId: string; startedAt: number; codewatch?: CodewatchEvidence } & ReviewIntent & BusyWaits) | NoReview | NotStarted;

export interface AwaitVerdictInput {
  repo: string;
  pr: number;
  head: string;
  reviewerAgentId: string;
  reviewerSessionId: string;
  /** Epoch milliseconds. */
  dispatchedAt: number;
  /** Epoch milliseconds when the reviewer's session was up; the wait counts from it. Absent on a run recorded before it existed. */
  startedAt?: number;
}

/** One assistant message, attributed by the reader to the agent and session it came from. */
export interface ReviewerMessage {
  agentId: string;
  sessionId: string;
  /** Epoch milliseconds. */
  writtenAt: number;
  text: string;
  locator: SourceTextLocator;
}

/** The assistant messages of the dispatched reviewer's session, oldest first; the last one is the final message. */
export interface ReviewerReader {
  read(input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]>;
  /** A seat reviewer's sent messages from every complete record, finished turn or not; rejects on a damaged transcript, with a `DamagedTranscriptError` for a partial last record. Absent means `read`. */
  readSeat?(input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]>;
}

export interface AcceptedVerdict {
  kind: "verdict";
  head: string;
  locator: SourceTextLocator;
  /** The author of the accepted message, as the reader attributed it. */
  reviewer: AgentIdentity;
}

/** Only a FIX_FIRST keeps the reviewer's words, because the implementer has to read them. */
export type AwaitVerdictResult = (AcceptedVerdict & { verdict: "MERGE" }) | (AcceptedVerdict & { verdict: "FIX_FIRST"; text: string }) | { kind: "none"; reason?: string };

const HeadSchema = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const ReviewTargetSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), pr: z.number().int().positive(), head: HeadSchema });
const ReviewInputSchema = ReviewTargetSchema.extend({ runId: z.string().min(1), fresh: z.boolean().optional() });
/** `at` is epoch milliseconds. `agentId` is known only for a resume; a spawned agent gets its id from the broker. `external` starts nobody. */
const ReviewIntentSchema = z.object({ head: HeadSchema, reviewer: z.string().min(1), at: z.number(), mode: z.enum(["spawn", "resume", "external"]), agentId: z.string().min(1).optional() });
/** `fixFirsts` counts the run's earlier FIX_FIRST reviews; one or more makes the brief a re-review. */
const ReviewDispatchInputSchema = ReviewTargetSchema.extend({ intent: ReviewIntentSchema, fixFirsts: z.number().int().positive().optional() });

type Parents = (agent: ReviewerAgent) => readonly (string | null | undefined)[];
const takeovers: Parents = (agent) => [agent.predecessor];
const descent: Parents = (agent) => [agent.spawnedBy, agent.predecessor];

/** `name` and every name above it; undefined when a link is absent from the roster, has no stored lineage, or loops back. */
function ancestry(name: string, roster: readonly ReviewerAgent[], parents: Parents, path: readonly string[] = []): ReadonlySet<string> | undefined {
  if (path.includes(name)) return undefined;
  const rows = roster.filter((agent) => agent.name === name);
  if (rows.length === 0 || rows.some((agent) => agent.predecessor === undefined)) return undefined;
  const found = new Set([name]);
  for (const parent of rows.flatMap(parents)) {
    if (parent === null || parent === undefined) continue;
    const above = ancestry(parent, roster, parents, [...path, name]);
    if (!above) return undefined;
    above.forEach((ancestor) => found.add(ancestor));
  }
  return found;
}

/** Proven only from roster facts: nobody who wrote the code is the agent, spawned it, or handed over to it, at any depth. */
export function provablyIndependent(agent: ReviewerAgent, implementer: string, roster: readonly ReviewerAgent[]): boolean {
  const wrote = ancestry(implementer, roster, takeovers);
  const above = ancestry(agent.name, roster, descent);
  return wrote !== undefined && above !== undefined && ![...wrote].some((author) => above.has(author));
}

/** The registration's opt-in reviewer, only when it is provably independent of the implementer, has ended, and has room left. */
function standingReviewer(registration: Registration | undefined, roster: readonly ReviewerAgent[]): ReviewerAgent | undefined {
  const name = registration?.policy.reviewer;
  if (registration === undefined || name === undefined) return undefined;
  const named = roster.filter((agent) => agent.name === name);
  const agent = named[0];
  if (named.length !== 1 || agent === undefined) return undefined;
  const resumable = agent.presence === "exited" && agent.sessionId !== "" && agent.fillTokens !== undefined && agent.fillTokens < MAX_RESUME_FILL_TOKENS;
  return resumable && provablyIndependent(agent, registration.implementer, roster) ? agent : undefined;
}

/** A name no agent in the roster has held, so a fresh reviewer is never confused with an earlier agent. */
function freshName(target: ReviewTarget, implementer: string | undefined, roster: readonly ReviewerAgent[]): string {
  const taken = new Set([...roster.map((agent) => agent.name), implementer]);
  const base = freshReviewerBase(target.repo, target.pr);
  for (let k = 1; ; k += 1) {
    const name = k === 1 ? base : `${base}-${k}`;
    if (!taken.has(name)) return name;
  }
}

/** A hold that names a reviewer waits for that reviewer; `fresh` skips the standing reviewer, which may be the one that went silent. */
function chooseReviewer(target: ReviewTarget, registration: Registration | undefined, roster: readonly ReviewerAgent[], fresh = false): Omit<ReviewIntent, "head" | "at"> {
  const external = externalReviewer(registration);
  if (external) return { mode: "external", reviewer: external };
  const standing = fresh ? undefined : standingReviewer(registration, roster);
  if (standing) return { mode: "resume", reviewer: standing.name, agentId: standing.agentId };
  return { mode: "spawn", reviewer: freshName(target, registration?.implementer, roster) };
}

type Timing = Pick<AwaitVerdictTiming, "now" | "sleep" | "pollMs">;

/** Waits out a broker that is down; any other failure is the caller's to handle. */
async function whileBrokerDown<T>(timing: Timing, signal: AbortSignal, ask: () => Promise<T>): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof ReviewerBrokerDown)) throw error;
    }
    await timing.sleep(timing.pollMs, signal);
  }
}

/** Spawns or resumes the intent's reviewer, waiting out a broker that is down or busy; the watch row names a busy wait while it lasts, and `waits` keeps each one. */
async function startReviewer(dispatch: ReviewerDispatch, intent: ReviewIntent, target: ReviewTarget, brief: string, timing: BusyTiming & Timing, signal: AbortSignal, waits: string[]): Promise<void> {
  const ask = () => (intent.mode === "resume" ? dispatch.resume(intent.reviewer, brief) : dispatch.spawn(intent.reviewer, brief, target));
  const note = (text: string) => {
    waits.push(text);
    noteReviewWait(target.repo, target.pr, `waiting for the broker to start reviewer ${intent.reviewer}: ${text}`);
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

async function startedReviewer(dispatch: ReviewerDispatch, intent: ReviewIntent, timing: AwaitVerdictTiming, signal: AbortSignal): Promise<ReviewerAgent | undefined> {
  const clock = deadline(timing);
  for (;;) {
    const found = (await dispatch.roster().catch(() => [])).filter(holds(intent));
    if (found.length > 1) return undefined;
    if (found[0] && found[0].sessionId !== "") return found[0];
    if (clock.expired()) return undefined;
    await clock.sleep(timing.pollMs, signal);
  }
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
  /** How long a busy broker is asked again before its refusal stands; absent means `DEFAULT_BUSY_WAIT_MS`. */
  busyWaitMs?: number;
  exitGraceMs?: number;
  detachGraceMs?: number;
  isFrozen?: IsFrozen;
  /** How the `sh-carry` probe reaches git; absent means the system git against the factory's cache. */
  carry?: Omit<CarryOptions, "signal">;
}

type Wired = ReviewWiring & { dispatch: ReviewerDispatch };
const brokerTiming = (deps: ShepherdDeps): Timing => ({ now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs ?? DEFAULT_POLL_MS });

type BrokerStepBody<I, T> = (deps: ShepherdDeps, wired: Wired, input: I, signal: AbortSignal, repeat: boolean) => Promise<T>;

/** A malformed input fails the step. With no dispatch wired the step answers `none` at once, and a throw from its body is a refusal; either way the owner gate decides. */
const brokerStep = <I, T extends object>(deps: ShepherdDeps, wiring: ReviewWiring | undefined, schema: z.ZodType<I>, body: BrokerStepBody<I, T>) =>
  async (raw: unknown, signal: AbortSignal, repeat = false): Promise<T | NoReview> => {
    const input = schema.parse(raw);
    const dispatch = wiring?.dispatch;
    if (!dispatch) return { kind: "none", reason: "no reviewer dispatch is wired" };
    return body(deps, { ...wiring, dispatch }, input, signal, repeat).catch((error: unknown) => {
      signal.throwIfAborted();
      return { kind: "none", reason: `the reviewer dispatch was refused: ${error instanceof Error ? error.message : String(error)}` };
    });
  };

/** The body of the sh-review-intent step. It asks the broker for nothing but the roster, so a repeat changes nothing. */
const reviewIntent: BrokerStepBody<ReviewInput, ReviewIntentResult> = async (deps, { dispatch }, input, signal) => {
  const roster = await whileBrokerDown(brokerTiming(deps), signal, () => dispatch.roster());
  const choice = chooseReviewer(input, deps.store.get().byRun(input.runId), roster, input.fresh);
  return { kind: "intent", head: input.head, ...choice, at: deps.now() };
};

/** The body of the sh-review step; `repeat` means a crash interrupted an earlier run. The brief is built from the target alone, so no registration text can reach it. */
const dispatchReview: BrokerStepBody<ReviewDispatchInput, ReviewDispatchResult> = async (deps, { dispatch, questions, codewatch, sessionStartTimeoutMs, busyWaitMs }, { intent, fixFirsts, ...target }, signal, repeat) => {
  const timing = { ...brokerTiming(deps), timeoutMs: sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS, busyWaitMs: busyWaitMs ?? DEFAULT_BUSY_WAIT_MS };
  const roster = await whileBrokerDown(timing, signal, () => dispatch.roster());
  // A held name was spawned by an earlier run, and a refused spawn holds none; a repeat that crashed before its resume landed asks again.
  const asked = roster.some(intent.mode === "resume" ? (agent) => repeat && resumedSince(intent)(agent) : holds(intent));
  const waits: string[] = [];
  const asking = asked ? undefined : await reviewBrief({ ...target, fixFirsts }, codewatch, questions);
  if (asking) {
    const refused = await startReviewer(dispatch, intent, target, asking.brief, timing, signal, waits).then(() => undefined, (error: unknown) => notStarted(error, waits));
    if (refused) return refused;
  }
  const started = await startedReviewer(dispatch, intent, timing, signal);
  if (!started) return { kind: "none", reason: `reviewer ${intent.reviewer} did not start one session in time` };
  return { kind: "dispatched", ...intent, agentId: started.agentId, sessionId: started.sessionId, startedAt: deps.now(), ...busyWaits(waits), ...(asking?.codewatch && { codewatch: asking.codewatch }) };
};

/** `codeRoute` for a body that must know it ran before: a first run is attempt 0, and only the recovery of an interrupted step raises it. */
function repeatAwareRoute<I>(match: string, now: () => number, fn: (input: I, signal: AbortSignal, repeat: boolean) => Promise<object>): StepRoute {
  const routeFor = (repeat: boolean) => codeRoute(match, now, (input: I, signal) => fn(input, signal, repeat));
  return { ...routeFor(false), runner: { run: (step) => routeFor(step.attempt > 0).runner.run(step) } };
}

/** With no reader wired the verdict step answers `none` at once, so the owner gate decides. */
export const reviewRoutes = (deps: ShepherdDeps, wiring?: ReviewWiring): readonly StepRoute[] => {
  const timing = { ...brokerTiming(deps), timeoutMs: wiring?.timeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS, exitGraceMs: wiring?.exitGraceMs, detachGraceMs: wiring?.detachGraceMs };
  const run = async (raw: unknown, signal: AbortSignal): Promise<AwaitVerdictResult> => {
    if (isExternalVerdictInput(raw)) return wiring?.dispatch ? bounded(await awaitExternalVerdict(wiring.dispatch.roster, wiring.reader, raw, timing, signal)) : { kind: "none" };
    const input = parseAwaitVerdictInput(raw);
    const dispatch = wiring?.dispatch;
    return wiring ? awaitVerdict(wiring.reader, input, timing, signal, dispatch && (() => dispatch.roster())) : { kind: "none" };
  };
  const isFrozen = wiring?.isFrozen ?? noFreezeStoreUntilTp523;
  return [
    codeRoute(REVIEW_INTENT_STEP, deps.now, brokerStep(deps, wiring, ReviewInputSchema, reviewIntent)),
    repeatAwareRoute(REVIEW_STEP, deps.now, brokerStep(deps, wiring, ReviewDispatchInputSchema, dispatchReview)),
    codeRoute(AWAIT_VERDICT_STEP, deps.now, seatVetoed(wiring, run)),
    codeRoute(LATE_VERDICT_STEP, deps.now, seatVetoed(wiring, (raw: unknown, signal) => lateVerdict(deps, wiring, parseAwaitVerdictInput(raw), signal))),
    codeRoute(MERGE_EVIDENCE_STEP, deps.now, async (input: MergeEvidenceInput) => mergeEvidence(deps.port, input, isFrozen, registeredKind(deps.store, input.runId))),
    carryRoute(deps.now, wiring?.carry),
  ];
};

/** With no dispatch wired there is no roster to tell an exited reviewer, so the step answers `none` at once. */
async function lateVerdict(deps: ShepherdDeps, wiring: ReviewWiring | undefined, input: AwaitVerdictInput, signal: AbortSignal): Promise<AwaitVerdictResult> {
  const dispatch = wiring?.dispatch;
  if (!dispatch) return { kind: "none" };
  const timing = { ...brokerTiming(deps), timeoutMs: wiring.lateVerdictMs ?? DEFAULT_LATE_VERDICT_MS };
  const exited = async () => (await dispatch.roster()).every((agent) => agent.agentId !== input.reviewerAgentId || agent.presence === "exited");
  return awaitLateVerdict(wiring.reader, exited, input, timing, signal);
}

const MergeEvidenceResult = z.looseObject({ head: z.string(), merge: z.looseObject({}), record: z.looseObject({}) });

/** A MERGE verdict at one head, carrying the facts and record collected there once; a replay reuses the step's output. */
export async function mergeVerdict(ctx: WorkflowContext, input: Omit<MergeEvidenceInput, "runId">): Promise<Verdict> {
  const request: MergeEvidenceInput = { ...input, runId: ctx.runId };
  const evidence = (await step(ctx, `${MERGE_EVIDENCE_STEP}:${input.head}`, request, MergeEvidenceResult)) as unknown as MergeEvidence;
  return { kind: "MERGE", headSha: input.head, evidence };
}

const Identity = z.object({ agentId: z.string().min(1), sessionId: z.string().min(1) });
const Intended = z.discriminatedUnion("kind", [z.looseObject({ kind: z.literal("intent"), mode: z.string(), reviewer: z.string() }), z.looseObject({ kind: z.literal("none") })]);
const Dispatched = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("dispatched"), at: z.number(), startedAt: z.number().optional(), ...Identity.shape }),
  z.looseObject({ kind: z.literal("none") }),
]);
const Awaited = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("verdict"), verdict: z.enum(["MERGE", "FIX_FIRST"]), head: z.string(), locator: z.looseObject({}), reviewer: Identity, text: z.string().optional() }),
  z.looseObject({ kind: z.literal("none") }),
]);

/** The grant is read from the run's own policy param, the ceiling a registration can only narrow. */
function seatGrants(ctx: WorkflowContext): string[] {
  const raw = ctx.param("policy");
  const policy = raw === undefined ? OWNER_GATE_POLICY : EffectivePolicySchema.parse(JSON.parse(raw));
  return policy.merge === "auto" ? [MERGE_ON_GREEN_GRANT] : [];
}

/**
 * Record which reviewer this head gets, start or adopt it, wait for its verdict, and take a MERGE through the evidence step.
 * The resolver comes from the verdict step and the dispatched reviewer from the dispatch step, so a mismatch between them gates.
 */
export const reviewPhase: ShepherdPhases["review"] = async (ctx, request) => {
  const target: ReviewTarget = { repo: request.repo, pr: request.pr, head: request.headSha };
  const intent = await step(ctx, `${REVIEW_INTENT_STEP}:${target.head}`, { ...target, runId: ctx.runId, ...(request.fresh && { fresh: true }) }, Intended);
  if (intent.kind !== "intent") return { kind: "none", cause: "no-verdict" };
  if (intent.mode === "external") return takeVerdict(ctx, target, { ...target, external: intent.reviewer }, undefined);
  const fixFirsts = ctx.iteration(FIX_FIRST_STEP);
  const dispatched = await step(ctx, `${REVIEW_STEP}:${target.head}`, { ...target, intent, ...(fixFirsts > 0 && { fixFirsts }) }, Dispatched);
  if (dispatched.kind !== "dispatched") return { kind: "none", cause: dispatched.notStarted === true ? "not-started" : "no-verdict" };
  const dispatchedReviewer: AgentIdentity = { agentId: dispatched.agentId, sessionId: dispatched.sessionId };
  const awaiting: AwaitVerdictInput = { ...target, reviewerAgentId: dispatched.agentId, reviewerSessionId: dispatched.sessionId, dispatchedAt: dispatched.at, ...(dispatched.startedAt !== undefined && { startedAt: dispatched.startedAt }) };
  return takeVerdict(ctx, target, awaiting, dispatchedReviewer);
};

/**
 * An external reviewer is both the dispatched reviewer and the resolver, because Shepherd started nobody else. A dispatched
 * reviewer that missed the wait is read once more, so a MERGE it writes late is a MERGE, not a no-facts gate.
 */
async function takeVerdict(ctx: WorkflowContext, target: ReviewTarget, awaiting: object, dispatchedReviewer: AgentIdentity | undefined): Promise<Verdict> {
  const onTime = await step(ctx, `${AWAIT_VERDICT_STEP}:${target.head}`, awaiting, Awaited);
  const awaited = onTime.kind === "none" && dispatchedReviewer ? await step(ctx, `${LATE_VERDICT_STEP}:${target.head}`, awaiting, Awaited) : onTime;
  if (awaited.kind !== "verdict") return { kind: "none", cause: dispatchedReviewer ? "timeout" : "external-hold", ...(typeof awaited.reason === "string" && { reason: awaited.reason }) };
  if (awaited.verdict === "FIX_FIRST") return { kind: "FIX_FIRST", headSha: target.head, text: awaited.text ?? "" };
  const verdict = { value: "MERGE" as const, head: awaited.head, locator: awaited.locator as unknown as SourceTextLocator };
  return mergeVerdict(ctx, { ...target, verdict, resolver: awaited.reviewer, dispatchedReviewer: dispatchedReviewer ?? awaited.reviewer, seatGrants: seatGrants(ctx) });
}
