import { acceptVerdict, aggregate, correctionPrompt, isUsageLimit, memberName, readMalformed, reviewerBrief, shapeBrief } from "@titan-design/review-panel";
import type { AwaitVerdictInput, Malformed, MemberResult, PanelPlan, PanelVerdict, ReviewShape, ReviewTarget } from "@titan-design/review-panel";
import type { AwaitRecord, DispatchRecord } from "./failure.js";
import { requestFixer, type FixerRecord, type FixerRequest, type ParkingPort } from "./fixer.js";
import { applyHeal, type HealEffect, type HealSubject } from "./heal.js";
import type { ReviewWorkflowPorts } from "./ports.js";
import type { PreflightSnapshot } from "./preflight.js";
import { preflightRead, type PreflightReadInput } from "./preflight-read.js";
import type { HealKind } from "./retry-policy.js";
import type { CorrectRecord } from "./step-schemas.js";
import type { ReviewHeadInput, ReviewOutcome } from "./types.js";

/** The fixer parks runs, so its body takes the parking port beside the review's own. */
export type ReviewBodyPorts = ReviewWorkflowPorts & { parking: ParkingPort };

/** Recorded in each waiting step's input, so a replay waits as the recorded run did. */
export interface ReviewTiming {
  pollMs: number;
  /** How long a member's session may take to start, from its spawn. */
  startDeadlineMs: number;
  /** How long a started member may take to write its verdict. */
  verdictDeadlineMs: number;
}

export const DEFAULT_REVIEW_TIMING: Readonly<ReviewTiming> = { pollMs: 30_000, startDeadlineMs: 10 * 60_000, verdictDeadlineMs: 60 * 60_000 };

export interface DispatchInput {
  target: ReviewTarget;
  shape: ReviewShape;
  profile: string;
  degraded: boolean;
  attempt: 1 | 2;
  kind?: string;
  brief: ReviewHeadInput["brief"];
  timing: ReviewTiming;
}

export type AwaitInput = AwaitVerdictInput & { timing: ReviewTiming };

export interface CorrectInput extends ReviewTarget {
  name: string;
  malformed: Malformed;
  ownerBrief?: boolean;
}

export interface AggregateStepInput {
  target: ReviewTarget;
  plan: PanelPlan;
  results: readonly MemberResult[];
  fixProof?: string;
  fixProofWaivedAt?: string;
  sonnetFor?: Record<string, string>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function briefFor({ shape, brief, target }: DispatchInput): string {
  const input = { ...brief, ...target };
  return shape === "correctness" ? reviewerBrief(input) : shapeBrief(shape, input);
}

/** Polls the roster until the named row has a session; an unreadable roster counts as not yet. */
async function sessionOf(ports: ReviewBodyPorts, name: string, timing: ReviewTiming, signal: AbortSignal) {
  const end = ports.clock.now() + timing.startDeadlineMs;
  for (;;) {
    signal.throwIfAborted();
    const row = (await ports.dispatch.roster().catch(() => [])).find((agent) => agent.name === name);
    if (row !== undefined && row.sessionId !== "") return row;
    if (ports.clock.now() >= end) return undefined;
    await ports.clock.sleep(timing.pollMs);
  }
}

/**
 * Spawns the member under its pure name, so a repeat after a crash finds the roster row and spawns nothing; that row's
 * dispatch time is 0 because the name already pins the head. A refused spawn keeps its error class for `classifyFailure`.
 */
async function dispatchMember(input: DispatchInput, ports: ReviewBodyPorts, signal: AbortSignal): Promise<DispatchRecord> {
  const name = (ports.namer ?? memberName)(input.target, input.shape, input.attempt);
  const member = { name, profile: input.profile, degraded: input.degraded };
  const existing = (await ports.dispatch.roster()).some((row) => row.name === name);
  const dispatchedAt = existing ? 0 : ports.clock.now();
  if (!existing) {
    const facts = { ...(input.kind !== undefined && { kind: input.kind }), profile: input.profile };
    try {
      await ports.dispatch.spawn(name, briefFor(input), input.target, facts, signal);
    } catch (error) {
      return { kind: "refused", ...member, error: error instanceof Error ? error.name : "Error", message: errorText(error) };
    }
  }
  const row = await sessionOf(ports, name, input.timing, signal);
  if (row === undefined) return { kind: "never-started", ...member };
  return { kind: "started", ...member, agentId: row.agentId, sessionId: row.sessionId, dispatchedAt, startedAt: ports.clock.now() };
}

/** A malformed final message ends the wait at once, since the reviewer's turn is over; WAIT and silence keep it going. */
async function awaitMember({ timing, ...input }: AwaitInput, ports: ReviewBodyPorts, signal: AbortSignal): Promise<AwaitRecord> {
  const end = ports.clock.now() + timing.verdictDeadlineMs;
  for (;;) {
    signal.throwIfAborted();
    const result = acceptVerdict(input, await ports.reader.read(input).catch(() => []));
    if (result.kind === "verdict" || isUsageLimit(result) || readMalformed(result)) return result;
    if (ports.clock.now() >= end) return { kind: "timeout" };
    await ports.clock.sleep(timing.pollMs);
  }
}

/** One read of a timed-out member's transcript before a fresh member is spawned (`sh-late-verdict`). */
async function lateRead({ timing: _timing, ...input }: AwaitInput, ports: ReviewBodyPorts): Promise<AwaitRecord> {
  return acceptVerdict(input, await ports.reader.read(input).catch(() => []));
}

/** One correction turn in the member's own session; its reply is read by a separate await from the malformed message on. */
async function correctMember({ name, malformed, ownerBrief, ...target }: CorrectInput, ports: ReviewBodyPorts, signal: AbortSignal): Promise<CorrectRecord> {
  const prompt = correctionPrompt({ ...target, refusal: malformed.refusal, ...(malformed.quotes && { quotes: malformed.quotes }), ...(ownerBrief === true && { ownerBrief }) });
  try {
    await ports.dispatch.resume(name, prompt, signal);
  } catch (error) {
    return { kind: "none", reason: errorText(error) };
  }
  return { kind: "asked", startedAt: ports.clock.now() };
}

async function aggregateMembers({ target, plan, results, ...proof }: AggregateStepInput, ports: ReviewBodyPorts): Promise<PanelVerdict> {
  return aggregate(plan, results, { head: target.head, source: ports.source, ...proof });
}

/** Each heal once, in order; the first that stops the run or cannot act ends the pass. */
async function healPass({ heals, subject }: { heals: readonly HealKind[]; subject: HealSubject }, ports: ReviewBodyPorts): Promise<HealEffect> {
  let healed = subject;
  for (const heal of heals) {
    const effect = await applyHeal(heal, healed, ports);
    if (effect.kind !== "healed") return effect;
    healed = effect.subject;
  }
  return { kind: "healed", subject: healed };
}

async function fixerStep(request: FixerRequest, ports: ReviewBodyPorts): Promise<{ record: FixerRecord; outcome: ReviewOutcome }> {
  return requestFixer(ports, request);
}

/** The intent records the plan the members are dispatched from, so a replay dispatches the recorded panel. */
async function recordIntent({ plan }: { plan: PanelPlan }): Promise<{ plan: PanelPlan }> {
  return { plan };
}

async function preflightBody(input: PreflightReadInput, ports: ReviewBodyPorts): Promise<PreflightSnapshot> {
  return preflightRead(input, ports);
}

type Body<I> = (input: I, ports: ReviewBodyPorts, signal: AbortSignal) => Promise<object>;

/**
 * Every read and effect `reviewHead` takes, by its `ReviewStepIds` key. A host registers each under the id it injects,
 * so the recipe stays control flow only.
 */
export const REVIEW_STEP_BODIES = {
  preflight: preflightBody,
  heal: healPass,
  intent: recordIntent,
  dispatch: dispatchMember,
  await: awaitMember,
  correct: correctMember,
  lateRead,
  aggregate: aggregateMembers,
  fixer: fixerStep,
} satisfies Record<string, Body<never>>;
