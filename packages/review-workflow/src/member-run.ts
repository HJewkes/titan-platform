import { readMalformed, type MemberResult, type PanelMember, type ReviewShape, type ReviewTarget } from "@titan-design/review-panel";
import type { DispatchInput, ReviewTiming } from "./bodies.js";
import { classifyFailure, repeats, type AwaitRecord, type ClassifiedFailure, type DispatchRecord } from "./failure.js";
import type { FixerCase } from "./fixer.js";
import type { HealKind, RetryPolicy, RetryRule, RetryStep, RetryTerminal } from "./retry-policy.js";
import { AwaitRecordSchema, CorrectRecordSchema, DispatchRecordSchema, type StepCall } from "./step-schemas.js";
import type { FailureClass, ReviewHeadInput, ReviewStepIds } from "./types.js";

/** What every member of one head shares. */
export interface MemberContext {
  call: StepCall;
  ids: ReviewStepIds;
  input: ReviewHeadInput;
  policy: RetryPolicy;
  sonnetFor: Record<string, string>;
  timing: ReviewTiming;
}

/** One attempt's records: the dispatch and, once started, the await that read it. */
export interface Seen {
  dispatch: DispatchRecord;
  awaited?: AwaitRecord;
}

export type MemberEnd =
  | { kind: "result"; result: MemberResult; failures: readonly FailureClass[]; dispatches: readonly DispatchRecord[] }
  | { kind: "fixer"; fixerCase: FixerCase; dispatches: readonly DispatchRecord[] }
  | { kind: "account-hold"; resetsAt?: number };

interface MemberState {
  member: PanelMember;
  attempt: 1 | 2;
  /** How often each row step was taken, by `<class>:<step index>`; one member's budget spans both attempts. */
  used: Map<string, number>;
  last?: ClassifiedFailure;
  failures: FailureClass[];
  dispatches: DispatchRecord[];
}

type Taken = { seen: Seen } | { end: MemberEnd } | undefined;

/** Correctness keeps the bare `<id>:<head>`, as Shepherd's single reviewer recorded it; each other member adds its shape. */
export function memberStepId(id: string, head: string, shape: ReviewShape, attempt: 1 | 2 = 1, suffix = ""): string {
  return [id, head, ...(shape === "correctness" ? [] : [shape]), ...(attempt === 2 ? ["r2"] : []), ...(suffix === "" ? [] : [suffix])].join(":");
}

const target = (ctx: MemberContext): ReviewTarget => ctx.input.target;

export async function dispatchStep(ctx: MemberContext, member: PanelMember, attempt: 1 | 2): Promise<DispatchRecord> {
  const { shape, profile, degraded } = member;
  const kind = ctx.input.kind === undefined ? {} : { kind: ctx.input.kind };
  const input: DispatchInput = { target: target(ctx), shape, profile, degraded, attempt, ...kind, brief: ctx.input.brief, timing: ctx.timing };
  return ctx.call(memberStepId(ctx.ids.dispatch, target(ctx).head, member.shape, attempt), input, DispatchRecordSchema);
}

function awaitInput(ctx: MemberContext, shape: ReviewShape, started: Extract<DispatchRecord, { kind: "started" }>, dispatchedAt = started.dispatchedAt) {
  return { ...target(ctx), shape, reviewerAgentId: started.agentId, reviewerSessionId: started.sessionId, dispatchedAt, startedAt: started.startedAt, timing: ctx.timing };
}

async function awaitStep(ctx: MemberContext, state: MemberState, dispatch: DispatchRecord): Promise<Seen> {
  if (dispatch.kind !== "started") return { dispatch };
  const id = memberStepId(ctx.ids.await, target(ctx).head, state.member.shape, state.attempt);
  return { dispatch, awaited: await ctx.call(id, awaitInput(ctx, state.member.shape, dispatch), AwaitRecordSchema) };
}

/** The next step of the row whose budget is not spent, counted as taken. */
function takeStep(rule: RetryRule, state: MemberState): RetryStep | undefined {
  for (const [index, step] of rule.steps.entries()) {
    const key = `${rule.class}:${index}`;
    const used = state.used.get(key) ?? 0;
    if (step.times !== null && used >= step.times) continue;
    state.used.set(key, used + 1);
    return step;
  }
  return undefined;
}

/** A fresh member under the attempt-2 name; a member gets one, whichever class asked for it. */
async function retry(ctx: MemberContext, state: MemberState, member: PanelMember = state.member): Promise<Taken> {
  if (state.attempt === 2) return undefined;
  state.attempt = 2;
  state.member = member;
  const dispatch = await dispatchStep(ctx, member, 2);
  state.dispatches.push(dispatch);
  return { seen: await awaitStep(ctx, state, dispatch) };
}

async function correct(ctx: MemberContext, state: MemberState, seen: Seen): Promise<Taken> {
  const malformed = readMalformed(seen.awaited);
  if (seen.dispatch.kind !== "started" || !malformed) return undefined;
  const { shape } = state.member;
  const head = target(ctx).head;
  const ownerBrief = ctx.input.brief.ownerBrief === true && shape === "correctness";
  const correction = { ...target(ctx), name: seen.dispatch.name, malformed, ...(ownerBrief && { ownerBrief }) };
  const asked = await ctx.call(memberStepId(ctx.ids.correct, head, shape, state.attempt), correction, CorrectRecordSchema);
  if (asked.kind !== "asked") return undefined;
  const reply = awaitInput(ctx, shape, { ...seen.dispatch, startedAt: asked.startedAt }, malformed.writtenAt);
  return { seen: { dispatch: seen.dispatch, awaited: await ctx.call(memberStepId(ctx.ids.await, head, shape, state.attempt, "corrected"), reply, AwaitRecordSchema) } };
}

async function lateRead(ctx: MemberContext, state: MemberState, seen: Seen): Promise<Taken> {
  if (seen.dispatch.kind !== "started") return undefined;
  const id = memberStepId(ctx.ids.lateRead, target(ctx).head, state.member.shape, state.attempt);
  const awaited = await ctx.call(id, awaitInput(ctx, state.member.shape, seen.dispatch), AwaitRecordSchema);
  return awaited.kind === "verdict" ? { seen: { dispatch: seen.dispatch, awaited } } : undefined;
}

/** A refused premium member is spawned fresh at its sonnet profile and marked degraded (TP-1931). */
function degrade(ctx: MemberContext, state: MemberState): Promise<Taken> | undefined {
  const { member } = state;
  const sonnet = Object.hasOwn(ctx.sonnetFor, member.profile) ? ctx.sonnetFor[member.profile] : undefined;
  return sonnet === undefined || member.degraded ? undefined : retry(ctx, state, { ...member, profile: sonnet, degraded: true });
}

async function runStep(ctx: MemberContext, state: MemberState, seen: Seen, step: RetryStep): Promise<Taken> {
  switch (step.action) {
    case "retry":
      return retry(ctx, state);
    case "correct":
      return correct(ctx, state, seen);
    case "late-read":
      return lateRead(ctx, state, seen);
    case "heal":
      return heal(ctx, state, seen, step.heal);
  }
}

/** Only the member heals act here; a checkout refresh or a retarget belongs to preflight, so it takes nothing. */
function heal(ctx: MemberContext, state: MemberState, seen: Seen, kind: HealKind): Promise<Taken> | Taken {
  if (kind === "degrade-headroom") return degrade(ctx, state);
  if (kind === "await-account") return { end: { kind: "account-hold", ...accountReset(seen.awaited) } };
  return undefined;
}

const accountReset = (awaited: AwaitRecord | undefined): { resetsAt?: number } =>
  awaited !== undefined && "resetsAt" in awaited && typeof awaited.resetsAt === "number" ? { resetsAt: awaited.resetsAt } : {};

function terminal(state: MemberState, failure: ClassifiedFailure, then: RetryTerminal): MemberEnd {
  const dispatches = state.dispatches;
  if (then.kind === "fixer") return { kind: "fixer", fixerCase: { failure: failure.class, key: then.key, detail: [failure.detail ?? state.member.shape] }, dispatches };
  const result: MemberResult = { shape: state.member.shape, result: { kind: "none", reason: failure.class }, ...(state.member.degraded && { degraded: true }) };
  return { kind: "result", result, failures: state.failures, dispatches };
}

/** Takes row steps until one observes a new attempt; a repeat of the same failure, or a spent row, ends at the row's terminal. */
async function act(ctx: MemberContext, state: MemberState, seen: Seen, failure: ClassifiedFailure, repeated: boolean): Promise<{ seen: Seen } | { end: MemberEnd }> {
  const rule = ctx.policy.find((row) => row.class === failure.class);
  if (rule === undefined) throw new Error(`the retry policy has no row for ${failure.class}`);
  for (;;) {
    const step = repeated ? undefined : takeStep(rule, state);
    if (step === undefined) return { end: terminal(state, failure, rule.then) };
    const taken = await runStep(ctx, state, seen, step);
    if (taken !== undefined) return taken;
  }
}

function settled(state: MemberState, seen: Seen): MemberEnd {
  const result: MemberResult = { shape: state.member.shape, result: seen.awaited ?? { kind: "none" }, ...(state.member.degraded && { degraded: true }) };
  return { kind: "result", result, failures: state.failures, dispatches: state.dispatches };
}

/**
 * Awaits one dispatched member and walks its policy row: a member with a verdict is settled and never dispatched again
 * (tp#2145 spent 8 sessions on 2 verdicts), and each failure takes only the steps its class allows.
 */
export async function reviewMember(ctx: MemberContext, member: PanelMember, dispatch: DispatchRecord): Promise<MemberEnd> {
  const state: MemberState = { member, attempt: 1, used: new Map(), failures: [], dispatches: [dispatch] };
  let seen = await awaitStep(ctx, state, dispatch);
  for (;;) {
    const failure = classifyFailure(seen.dispatch, seen.awaited, ctx.sonnetFor);
    if (failure === undefined) return settled(state, seen);
    const repeated = repeats(state.last, failure);
    state.last = failure;
    state.failures.push(failure.class);
    const next = await act(ctx, state, seen, failure, repeated);
    if ("end" in next) return next.end;
    seen = next.seen;
  }
}
