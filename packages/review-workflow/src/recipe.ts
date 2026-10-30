import { DEFAULT_SONNET_FOR, type PanelMember, type PanelPlan, type PanelVerdict } from "@titan-design/review-panel";
import { DEFAULT_REVIEW_TIMING, type ReviewTiming } from "./bodies.js";
import type { DispatchRecord } from "./failure.js";
import { fixerFingerprint, type FixerCase, type FixerMember } from "./fixer.js";
import { dispatchStep, reviewMember, type MemberContext, type MemberEnd } from "./member-run.js";
import type { ReviewPlanPolicy } from "./plan-for-head.js";
import { preflight, type PreflightDecision } from "./preflight.js";
import { DEFAULT_RETRY_POLICY, type HealKind, type RetryPolicy, type RetryTerminal } from "./retry-policy.js";
import { FixerStepSchema, HealRecordSchema, IntentRecordSchema, PreflightRecordSchema, VerdictRecordSchema, type StepCall } from "./step-schemas.js";
import { DEFAULT_REVIEW_STEP_IDS, type FailureClass, type ReviewHeadInput, type ReviewOutcome, type ReviewStepIds } from "./types.js";

/** The rule files one review reads; a hill-climbing variant replaces data here, never the recipe. */
export interface ReviewHeadPolicy {
  plan: ReviewPlanPolicy;
  /** Absent means `DEFAULT_RETRY_POLICY`. */
  retry?: RetryPolicy;
  timing?: Partial<ReviewTiming>;
}

export interface ReviewHost {
  call: StepCall;
  /**
   * The next recorded step while a run replays, as `WorkflowContext.historyNext`. A step this recipe added is skipped when
   * the record names another step there, so a run recorded before it replays unchanged. Absent means nothing replays.
   */
  historyNext?: () => string | undefined;
  ids?: Partial<ReviewStepIds>;
}

type Decided = { kind: "plan"; plan: PanelPlan } | { kind: "outcome"; outcome: ReviewOutcome } | { kind: "fixer"; fixerCase: FixerCase };

interface Run extends MemberContext {
  host: ReviewHost;
  plan: ReviewPlanPolicy;
  /** `<step id>: <record kind>` for every step taken, quoted to a fixer as its evidence. */
  trail: string[];
}

const skipped = (host: ReviewHost, stepId: string): boolean => {
  const next = host.historyNext?.();
  return next !== undefined && next !== stepId;
};

const healIneffective = (heals: readonly string[]): Decided => ({ kind: "fixer", fixerCase: { failure: "heal-ineffective", key: "heal-ineffective", detail: [...heals] } });

function decided(decision: PreflightDecision): Decided | undefined {
  if (decision.kind === "stop") return { kind: "outcome", outcome: decision.outcome };
  if (decision.kind === "fixer") return decision;
  return decision.kind === "go" ? { kind: "plan", plan: decision.plan.plan } : undefined;
}

/** One heal pass, then one re-read and re-decision; a decision that still asks for a heal goes to the fixer, never a second pass. */
async function healed(run: Run, heals: readonly HealKind[]): Promise<Decided> {
  const { target, hold } = run.input;
  const head = target.head;
  const effect = await run.call(`${run.ids.heal}:${head}`, { heals, subject: { target } }, HealRecordSchema);
  if (effect.kind === "stop") return { kind: "outcome", outcome: effect.outcome };
  if (effect.kind === "ineffective") return healIneffective([effect.heal]);
  const snapshot = await run.call(`${run.ids.preflight}:${head}:healed`, { target, policy: run.plan, ...(hold && { hold }) }, PreflightRecordSchema);
  const decision = preflight(snapshot, run.plan);
  return decided(decision) ?? healIneffective(decision.kind === "heal" ? decision.heals : []);
}

/** Preflight decides before any reviewer starts; a run recorded before preflight existed reads its plan from the intent. */
async function decide(run: Run): Promise<Decided> {
  const { target, hold } = run.input;
  const preflightId = `${run.ids.preflight}:${target.head}`;
  if (skipped(run.host, preflightId)) return { kind: "plan", plan: (await run.call(`${run.ids.intent}:${target.head}`, { target }, IntentRecordSchema)).plan };
  const snapshot = await run.call(preflightId, { target, policy: run.plan, ...(hold && { hold }) }, PreflightRecordSchema);
  const decision = preflight(snapshot, run.plan);
  const next = decision.kind === "heal" ? await healed(run, decision.heals) : decided(decision);
  if (next === undefined) throw new Error("preflight returned no decision");
  if (next.kind !== "plan") return next;
  return { kind: "plan", plan: (await run.call(`${run.ids.intent}:${target.head}`, { target, plan: next.plan }, IntentRecordSchema)).plan };
}

function fixerMember(dispatch: DispatchRecord): FixerMember {
  if (dispatch.kind === "started") return { name: dispatch.name, agentId: dispatch.agentId, sessionId: dispatch.sessionId };
  return { name: dispatch.name, refused: dispatch.kind === "refused" ? dispatch.message : "its session never started" };
}

/** Parks the run on its fingerprint; a run recorded before the fixer step existed is parked without a spawn. */
async function needsFixer(run: Run, fixerCase: FixerCase, dispatches: readonly DispatchRecord[] = []): Promise<ReviewOutcome> {
  const { target, runId } = run.input;
  const stepId = `${run.ids.fixer}:${target.head}`;
  if (skipped(run.host, stepId)) return { kind: "needs-fixer", head: target.head, fingerprint: fixerFingerprint(fixerCase), failure: fixerCase.failure };
  const request = { runId, target, fixerCase, evidence: { steps: [...run.trail], members: dispatches.map(fixerMember) } };
  return (await run.call(stepId, request, FixerStepSchema)).outcome;
}

/** Every member is started before any verdict is awaited, so they review side by side; each then walks its own policy row. */
async function fanOut(run: Run, plan: PanelPlan): Promise<MemberEnd[]> {
  const dispatched: { member: PanelMember; dispatch: DispatchRecord }[] = [];
  for (const member of plan.members) dispatched.push({ member, dispatch: await dispatchStep(run, member, 1) });
  const ends: MemberEnd[] = [];
  for (const { member, dispatch } of dispatched) {
    const end = await reviewMember(run, member, dispatch);
    ends.push(end);
    if (end.kind !== "result") break;
  }
  return ends;
}

const uniqueClasses = (ends: readonly MemberEnd[]): FailureClass[] => [...new Set(ends.flatMap((end) => (end.kind === "result" ? end.failures : [])))];

/** The shortfall row's terminal: the fix-proof's missing tests seat is the author's NO_REPRO, never another reviewer. */
async function shortfall(run: Run, then: RetryTerminal, ends: readonly MemberEnd[]): Promise<ReviewOutcome> {
  const head = run.input.target.head;
  if (then.kind === "fixer") return needsFixer(run, { failure: "shortfall", key: then.key, detail: ["tests"] });
  if (then.kind === "stop" && then.outcome === "NO_REPRO") return { kind: "NO_REPRO", head, waivable: false };
  return { kind: "no-verdict", head, classes: [...uniqueClasses(ends), "shortfall"] };
}

async function outcomeOf(run: Run, verdict: PanelVerdict, ends: readonly MemberEnd[]): Promise<ReviewOutcome> {
  const head = run.input.target.head;
  if (verdict.outcome === "MERGE") return { kind: "MERGE", head, verdict };
  if (verdict.outcome === "FIX_FIRST") return { kind: "FIX_FIRST", head, verdict };
  const rule = run.policy.find((row) => row.class === "shortfall");
  if (verdict.fixProofShortfall === true && rule !== undefined) return shortfall(run, rule.then, ends);
  return { kind: "no-verdict", head, classes: uniqueClasses(ends) };
}

async function reviewPlan(run: Run, plan: PanelPlan): Promise<ReviewOutcome> {
  const ends = await fanOut(run, plan);
  const stopped = ends.find((end) => end.kind !== "result");
  if (stopped?.kind === "account-hold") return { kind: "account-hold", head: run.input.target.head, ...(stopped.resetsAt !== undefined && { resetsAt: stopped.resetsAt }) };
  if (stopped?.kind === "fixer") return needsFixer(run, stopped.fixerCase, stopped.dispatches);
  const results = ends.flatMap((end) => (end.kind === "result" ? [end.result] : []));
  const { fixProof, fixProofWaivedAt } = run.input.brief;
  const input = { target: run.input.target, plan, results, sonnetFor: run.sonnetFor, ...(fixProof !== undefined && { fixProof }), ...(fixProofWaivedAt !== undefined && { fixProofWaivedAt }) };
  return outcomeOf(run, await run.call(`${run.ids.aggregate}:${run.input.target.head}`, input, VerdictRecordSchema), ends);
}

function tracked(call: StepCall, trail: string[]): StepCall {
  return async (stepId, input, schema) => {
    const record = await call(stepId, input, schema);
    trail.push(`${stepId}: ${typeof record === "object" && record !== null && "kind" in record ? String(record.kind) : "recorded"}`);
    return record;
  };
}

/**
 * Reviews one PR head end to end over recorded steps: preflight, one heal pass, the plan, the member fan-out with each
 * member's policy row, the aggregate and a typed outcome. Control flow only: every read and effect is a step whose body
 * is in `REVIEW_STEP_BODIES`. It reviews a full head; Shepherd keeps its scoped re-review until it calls this recipe.
 */
export async function reviewHead(host: ReviewHost, input: ReviewHeadInput, policy: ReviewHeadPolicy): Promise<ReviewOutcome> {
  const trail: string[] = [];
  const run: Run = {
    host,
    call: tracked(host.call, trail),
    ids: { ...DEFAULT_REVIEW_STEP_IDS, ...host.ids },
    input,
    plan: policy.plan,
    policy: policy.retry ?? DEFAULT_RETRY_POLICY,
    sonnetFor: policy.plan.panel.sonnetFor ?? DEFAULT_SONNET_FOR,
    timing: { ...DEFAULT_REVIEW_TIMING, ...policy.timing },
    trail,
  };
  const next = await decide(run);
  if (next.kind === "outcome") return next.outcome;
  if (next.kind === "fixer") return needsFixer(run, next.fixerCase);
  return reviewPlan(run, next.plan);
}
