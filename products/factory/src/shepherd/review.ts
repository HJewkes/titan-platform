import type { AgentIdentity } from "@titan-design/authority";
import { parseVerdictBlock, type SourceTextLocator } from "@titan-design/session-read";
import type { StepDeclaration } from "../definition.js";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepRoute } from "../routed-runner.js";
import { deadline } from "../workflows/deadline.js";
import { codeRoute, step } from "../workflows/land.js";
import { freshReviewerBase } from "./cleanup.js";
import { MERGE_EVIDENCE_STEP, mergeEvidence, noFreezeStoreUntilTp523, type IsFrozen, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { ShepherdDeps, ShepherdPhases, Verdict } from "./phases.js";
import { EffectivePolicySchema, MERGE_ON_GREEN_GRANT, OWNER_GATE_POLICY } from "./policy.js";
import { reviewerBrief } from "./reviewer-brief.js";
import { isRepoKey } from "./seats.js";
import type { Registration } from "./store.js";

export const REVIEW_INTENT_STEP = "sh-review-intent";
export const REVIEW_STEP = "sh-review";
export const AWAIT_VERDICT_STEP = "sh-await-verdict";
export const REVIEW_STEPS: readonly StepDeclaration[] = [
  { id: REVIEW_INTENT_STEP, kind: "dispatch" },
  { id: REVIEW_STEP, kind: "dispatch" },
  { id: AWAIT_VERDICT_STEP, kind: "dispatch" },
  { id: MERGE_EVIDENCE_STEP, kind: "dispatch" },
];

export const DEFAULT_VERDICT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_SESSION_START_TIMEOUT_MS = 5 * 60_000;
/** A standing reviewer holding this much context or more is not resumed. */
export const MAX_RESUME_FILL_TOKENS = 300_000;
/** The most of a FIX_FIRST message the step output keeps, marker included; the findings come first, so the start is kept. */
export const MAX_FIX_FIRST_TEXT_CHARS = 16_000;
export const FIX_FIRST_TRUNCATED = "\n[truncated]";
const DEFAULT_POLL_MS = 30_000;
const HEAD = /^[0-9a-f]{40}$/;

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
}

/** The port throws this when the broker cannot be reached: nothing was asked of it, so asking again is safe. */
export class ReviewerBrokerDown extends Error {
  override readonly name = "ReviewerBrokerDown";
}

/** How Shepherd starts a reviewer; any other throw from `spawn` or `resume` is a refusal. */
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
export type ReviewDispatchResult = ({ kind: "dispatched"; agentId: string; sessionId: string } & ReviewIntent) | NoReview;

export interface AwaitVerdictInput {
  repo: string;
  pr: number;
  head: string;
  reviewerAgentId: string;
  reviewerSessionId: string;
  /** Epoch milliseconds. */
  dispatchedAt: number;
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
}

interface AcceptedVerdict {
  kind: "verdict";
  head: string;
  locator: SourceTextLocator;
  /** The author of the accepted message, as the reader attributed it. */
  reviewer: AgentIdentity;
}

/** Only a FIX_FIRST keeps the reviewer's words, because the implementer has to read them. */
export type AwaitVerdictResult = (AcceptedVerdict & { verdict: "MERGE" }) | (AcceptedVerdict & { verdict: "FIX_FIRST"; text: string }) | { kind: "none" };

export interface AwaitVerdictTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
}

export function parseAwaitVerdictInput(raw: unknown): AwaitVerdictInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value === "") throw new Error(`sh-await-verdict: ${name} must be a non-empty string`);
    return value;
  };
  const { pr, dispatchedAt } = input;
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) throw new Error("sh-await-verdict: pr must be a positive integer");
  if (typeof dispatchedAt !== "number" || !Number.isFinite(dispatchedAt)) throw new Error("sh-await-verdict: dispatchedAt must be epoch milliseconds");
  const head = text(input.head, "head");
  if (!HEAD.test(head)) throw new Error("sh-await-verdict: head must be 40 lowercase hex characters");
  return {
    repo: text(input.repo, "repo"),
    pr,
    head,
    reviewerAgentId: text(input.reviewerAgentId, "reviewerAgentId"),
    reviewerSessionId: text(input.reviewerSessionId, "reviewerSessionId"),
    dispatchedAt,
  };
}

function boundedFindings(text: string): string {
  if (text.length <= MAX_FIX_FIRST_TEXT_CHARS) return text;
  return text.slice(0, MAX_FIX_FIRST_TEXT_CHARS - FIX_FIRST_TRUNCATED.length) + FIX_FIRST_TRUNCATED;
}

/**
 * Accepts only the final message of the dispatched agent and session, written after dispatch, whose block names this PR at
 * this head. The reader's fields are not trusted: the locator must point into the dispatched session too, and no message
 * in the read may be written after the final one, so the latest message decides whatever order the reader gave.
 */
export function acceptVerdict(input: AwaitVerdictInput, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const final = messages.at(-1);
  if (!final) return { kind: "none" };
  if (final.agentId !== input.reviewerAgentId || final.sessionId !== input.reviewerSessionId) return { kind: "none" };
  if (final.locator?.source?.conversation?.nativeId !== input.reviewerSessionId) return { kind: "none" };
  if (typeof final.writtenAt !== "number" || !(final.writtenAt > input.dispatchedAt)) return { kind: "none" };
  if (messages.some((earlier) => earlier.writtenAt > final.writtenAt)) return { kind: "none" };
  const block = parseVerdictBlock(final.text);
  if (!block.ok) return { kind: "none" };
  if (block.repo !== input.repo || block.pr !== input.pr || block.head !== input.head) return { kind: "none" };
  const accepted: AcceptedVerdict = { kind: "verdict", head: block.head, locator: final.locator, reviewer: { agentId: final.agentId, sessionId: final.sessionId } };
  return block.verdict === "MERGE" ? { ...accepted, verdict: "MERGE" } : { ...accepted, verdict: "FIX_FIRST", text: boundedFindings(final.text) };
}

/** Polls until an acceptable block appears; the deadline ends the wait with `none`, and a failed read counts as nothing yet. */
export async function awaitVerdict(
  reader: ReviewerReader,
  input: AwaitVerdictInput,
  timing: AwaitVerdictTiming,
  signal: AbortSignal,
): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  for (;;) {
    const messages = await reader.read(input).catch(() => []);
    const result = acceptVerdict(input, messages);
    if (result.kind === "verdict") return result;
    if (clock.expired()) return { kind: "none" };
    await clock.sleep(timing.pollMs, signal);
  }
}

const HeadSchema = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const ReviewTargetSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), pr: z.number().int().positive(), head: HeadSchema });
const ReviewInputSchema = ReviewTargetSchema.extend({ runId: z.string().min(1) });
/** `at` is epoch milliseconds. `agentId` is known only for a resume; a spawned agent gets its id from the broker. */
const ReviewIntentSchema = z.object({ head: HeadSchema, reviewer: z.string().min(1), at: z.number(), mode: z.enum(["spawn", "resume"]), agentId: z.string().min(1).optional() });
const ReviewDispatchInputSchema = ReviewTargetSchema.extend({ intent: ReviewIntentSchema });

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
function provablyIndependent(agent: ReviewerAgent, implementer: string, roster: readonly ReviewerAgent[]): boolean {
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

function chooseReviewer(target: ReviewTarget, registration: Registration | undefined, roster: readonly ReviewerAgent[]): Omit<ReviewIntent, "head" | "at"> {
  const standing = standingReviewer(registration, roster);
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

/** A resumed reviewer is found by its agent id. A spawned one is the only agent under a name nobody held before. */
const holds = (intent: ReviewIntent) => (agent: ReviewerAgent) => (intent.agentId === undefined ? agent.name === intent.reviewer : agent.agentId === intent.agentId);

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
  timeoutMs?: number;
  sessionStartTimeoutMs?: number;
  isFrozen?: IsFrozen;
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
  const choice = chooseReviewer(input, deps.store.get().byRun(input.runId), roster);
  return { kind: "intent", head: input.head, ...choice, at: deps.now() };
};

/** The body of the sh-review step; `repeat` means a crash interrupted an earlier run. The brief is built from the target alone, so no registration text can reach it. */
const dispatchReview: BrokerStepBody<ReviewDispatchInput, ReviewDispatchResult> = async (deps, { dispatch, questions, sessionStartTimeoutMs }, { intent, ...target }, signal, repeat) => {
  const timing = { ...brokerTiming(deps), timeoutMs: sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS };
  const roster = await whileBrokerDown(timing, signal, () => dispatch.roster());
  // A held name was spawned by an earlier run. A resume leaves no mark on the roster, so only the first run asks for it.
  const asked = intent.mode === "resume" ? repeat : roster.some(holds(intent));
  if (!asked) {
    const brief = reviewerBrief({ ...target, questions: await questions?.(target) });
    await whileBrokerDown(timing, signal, () => (intent.mode === "resume" ? dispatch.resume(intent.reviewer, brief) : dispatch.spawn(intent.reviewer, brief, target)));
  }
  const started = await startedReviewer(dispatch, intent, timing, signal);
  if (!started) return { kind: "none", reason: `reviewer ${intent.reviewer} did not start one session in time` };
  return { kind: "dispatched", ...intent, agentId: started.agentId, sessionId: started.sessionId };
};

/** `codeRoute` for a body that must know it ran before: a first run is attempt 0, and only the recovery of an interrupted step raises it. */
function repeatAwareRoute<I>(match: string, now: () => number, fn: (input: I, signal: AbortSignal, repeat: boolean) => Promise<object>): StepRoute {
  const routeFor = (repeat: boolean) => codeRoute(match, now, (input: I, signal) => fn(input, signal, repeat));
  return { ...routeFor(false), runner: { run: (step) => routeFor(step.attempt > 0).runner.run(step) } };
}

/** With no reader wired the verdict step answers `none` at once, so the owner gate decides. */
export const reviewRoutes = (deps: ShepherdDeps, wiring?: ReviewWiring): readonly StepRoute[] => {
  const timing = { ...brokerTiming(deps), timeoutMs: wiring?.timeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS };
  const run = async (raw: unknown, signal: AbortSignal): Promise<AwaitVerdictResult> => {
    const input = parseAwaitVerdictInput(raw);
    return wiring ? awaitVerdict(wiring.reader, input, timing, signal) : { kind: "none" };
  };
  const isFrozen = wiring?.isFrozen ?? noFreezeStoreUntilTp523;
  return [
    codeRoute(REVIEW_INTENT_STEP, deps.now, brokerStep(deps, wiring, ReviewInputSchema, reviewIntent)),
    repeatAwareRoute(REVIEW_STEP, deps.now, brokerStep(deps, wiring, ReviewDispatchInputSchema, dispatchReview)),
    codeRoute(AWAIT_VERDICT_STEP, deps.now, run),
    codeRoute(MERGE_EVIDENCE_STEP, deps.now, async (input: MergeEvidenceInput) => mergeEvidence(deps.port, input, isFrozen)),
  ];
};

const MergeEvidenceResult = z.looseObject({ head: z.string(), merge: z.looseObject({}), record: z.looseObject({}) });

/** A MERGE verdict at one head, carrying the facts and record collected there once; a replay reuses the step's output. */
export async function mergeVerdict(ctx: WorkflowContext, input: Omit<MergeEvidenceInput, "runId">): Promise<Verdict> {
  const request: MergeEvidenceInput = { ...input, runId: ctx.runId };
  const evidence = (await step(ctx, `${MERGE_EVIDENCE_STEP}:${input.head}`, request, MergeEvidenceResult)) as unknown as MergeEvidence;
  return { kind: "MERGE", headSha: input.head, evidence };
}

const Identity = z.object({ agentId: z.string().min(1), sessionId: z.string().min(1) });
const Intended = z.discriminatedUnion("kind", [z.looseObject({ kind: z.literal("intent") }), z.looseObject({ kind: z.literal("none") })]);
const Dispatched = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("dispatched"), at: z.number(), ...Identity.shape }),
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
  const intent = await step(ctx, `${REVIEW_INTENT_STEP}:${target.head}`, { ...target, runId: ctx.runId }, Intended);
  if (intent.kind !== "intent") return { kind: "none" };
  const dispatched = await step(ctx, `${REVIEW_STEP}:${target.head}`, { ...target, intent }, Dispatched);
  if (dispatched.kind !== "dispatched") return { kind: "none" };
  const dispatchedReviewer: AgentIdentity = { agentId: dispatched.agentId, sessionId: dispatched.sessionId };
  const awaiting: AwaitVerdictInput = { ...target, reviewerAgentId: dispatched.agentId, reviewerSessionId: dispatched.sessionId, dispatchedAt: dispatched.at };
  const awaited = await step(ctx, `${AWAIT_VERDICT_STEP}:${target.head}`, awaiting, Awaited);
  if (awaited.kind !== "verdict") return { kind: "none" };
  if (awaited.verdict === "FIX_FIRST") return { kind: "FIX_FIRST", headSha: target.head, text: awaited.text ?? "" };
  const verdict = { value: "MERGE" as const, head: awaited.head, locator: awaited.locator as unknown as SourceTextLocator };
  return mergeVerdict(ctx, { ...target, verdict, resolver: awaited.reviewer, dispatchedReviewer, seatGrants: seatGrants(ctx) });
};
