import type { MergeMethod, RepoSlug } from "@titan-design/github";
import { codeStep, type WorkflowContext } from "@titan-design/workflow";
import type { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { stuckBehindDecision } from "../gate-brief.js";
import type { GateDecision, GatePolicy } from "../gate-policy.js";
import { BaseCheckResult, BaseWaitResult, type BaseCheck, type BaseCheckInput, type BaseWaitInput } from "./land-base.js";
import { landedOf, type LandedPr } from "./land-landed.js";
import { approveMergeGate, askedApproval, type ApprovalSource, type ApproveMergeFacts, type AskApproval } from "./land-approval.js";
import type { CiSnapshot, FailingCheck } from "./land-ci.js";
import { budgetSpent, recordRetry, retriesLeft, retryBackoffMs, restartUpdates, retryLanded, newUpdateBound, recordUpdate, resetBound, stuckBehindReason, waitsAgain, type UpdateBound } from "./land-budget.js";
import { SettleResult, settleOrGate, type SettleHold, type SettleInput, type UnsettledMerge } from "./land-settle.js";
import { UPDATE_RESENDS } from "./land-update.js";
import { rerunOrphaned } from "./land-orphan.js";
import { CiSnapshotResult, LandRulesResult, BackoffResult, MergePolicyResult, MergeResultResult, UpdateResultResult } from "./land-steps.js";

export { readCi, type CiSnapshot, type FailingCheck } from "./land-ci.js";
export { afterWrite } from "./land-ci-wait.js";
export { sleep } from "./deadline.js";
export { codeRoute, landRoutes, type LandDeps, type Timing } from "./land-routes.js";
export { DEVICE_CHECK, SET_ANSWER_ORIGIN, type ApprovalAnswer, type ApprovalQuestion, type AskApproval } from "./land-approval.js";
export { CI_BACKLOG_CEILING_FACTOR, CI_WAIT_ATTEMPTS, MAX_UPDATE_CYCLES, MAX_UPDATE_RETRIES, MISSING_CHECK_GRACE_MS, UPDATE_BUDGET_MS, newUpdateBound, type UpdateBound } from "./land-budget.js";

/** A backstop: every legitimate loop passes a gate or the update bound long before this. */
export const MAX_CI_CYCLES = 20;

/** Every step the land core calls; a workflow that uses `land` spreads these into its own declaration. */
export const LAND_STEPS: readonly StepDeclaration[] = [
  { id: "land-rules", kind: "dispatch", orphanSafe: true },
  { id: "ci-wait", kind: "dispatch", orphanSafe: true },
  { id: "ci-orphan-rerun", kind: "dispatch" },
  { id: "update-branch", kind: "dispatch" },
  { id: "update-backoff", kind: "dispatch" },
  { id: "base-check", kind: "dispatch", orphanSafe: true },
  { id: "base-wait", kind: "dispatch" },
  { id: "merge", kind: "dispatch" },
  { id: "merge-policy", kind: "dispatch" },
  { id: "merge-settle", kind: "dispatch" },
  { id: "approve-merge", kind: "assisted" },
  { id: "stuck-behind", kind: "assisted" },
];

export interface LandInput {
  repo: RepoSlug;
  pr: number;
  method?: MergeMethod;
  /** Task ids the squash subject names when the PR title lacks them. */
  taskIds?: string[];
  /** Which entry into `land` this is within one run; a pilot that re-enters after a rerun or a new head passes the next round. */
  round?: number;
  /** Updates since the last human gate, counted across every round of the run; a caller that re-enters `land` passes the same bound each time. */
  updateBound?: UpdateBound;
  /** The unsettled-merge wait at a head across every round of the run; a caller that re-enters `land` passes the same hold each time. */
  settleHold?: SettleHold;
  /** False stops `behind` instead of updating the branch, so the only head land merges is one the caller already saw. */
  update?: false;
}

/** What an `allowEvidence` hook learns about the merge the policy allowed. */
export interface MergeAllowContext {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  decision: GateDecision;
}

/** The approve-merge facts are each read at exactly the head the gate asks about; `sendBackOffered` true makes land return a `sent-back` stop on that answer. */
export interface LandOptions extends ApproveMergeFacts {
  /**
   * Consulted with the head before each merge of an untrusted head, and the decision is recorded in a `merge-policy`
   * step before any branch, so a replay reuses it. `gate` asks the owner through `approve-merge`, `deny` stops
   * `merge-denied`, and `allow` trusts that one head with no hitl gate, because hitl refuses every automation resolver.
   */
  policy: GatePolicy;
  /** Evidence the allowing caller vouches for, stored beside the policy trace in the `merge-policy` step. */
  allowEvidence?: (merge: MergeAllowContext) => Record<string, unknown>;
  /** A gate this names waits at its head on recorded backoff steps, refreshing the facts each time, before the owner is asked. */
  unsettled?: UnsettledMerge;
  /** Asked in place of the approve-merge gate at the head the policy gated; absent, land opens approve-merge. */
  askApproval?: AskApproval;
  /** Read at each base check; true lets a merge land in a base that is not the repo's default branch. Absent, only the default branch. */
  featureBase?: () => boolean;
  /** The base the merge evidence at this head was read on; one that differs from the live base is re-read before the decision. */
  evidenceBase?: (headSha: string) => string | undefined;
  /** Takes any read the decision on `base` still lacks at this head, such as a fix-proof judged on another base; called before each decision. */
  readOn?: (ctx: WorkflowContext, headSha: string, base: string) => Promise<void>;
  /**
   * Asked at an untrusted green head before its decision, then with the reason of a gated one; true merges the base into the
   * head through land's own update-branch, whose conflict stops `conflict` as any update's does. The hook records its own step.
   */
  mergeBaseFirst?: (ctx: WorkflowContext, at: MergeBaseAsk) => Promise<boolean>;
}

export interface MergeBaseAsk {
  headSha: string;
  base: string;
  /** The gated decision's reason; absent before the decision. */
  reason?: string;
}

export type LandOutcome =
  /** `mergeSha` is null when GitHub reports the PR merged but names no merge commit; `landed` is absent for a merge made elsewhere. */
  | { kind: "merged"; headSha: string; mergeSha: string | null; landed?: LandedPr; /** Set only when this run's own merge write landed, never for a PR GitHub reports merged elsewhere. */ own?: true }
  | { kind: "ci-failed"; headSha: string; failing: FailingCheck[] }
  /** On `sent-back`, `detail` is the owner's note for the implementer. */
  | { kind: "stopped"; reason: "closed" | "not-mergeable" | "conflict" | "abandoned" | "sent-back" | "stuck-behind" | "merge-denied" | "update-branch-unmoved" | "behind"; headSha: string; detail: string };

interface LandState {
  round: number;
  rules: z.infer<typeof LandRulesResult>;
  /** Rules reads after the round's first, each made because a confirmed read named a new base. */
  rulesReads: number;
  baseChecks: number;
  baseWaits: number;
  cycle: number;
  updates: number;
  retries: number;
  bound: UpdateBound;
  merges: number;
  decisions: number;
  /** Heads a resolved approve-merge gate covers: the approved head plus heads this run's updates built on it. */
  trusted: Set<string>;
  /** A policy allow or an approved-set answer covers only the head it named, so this run's updates never extend it. */
  trustedBy: ApprovalSource | "policy";
  /** The base the trusted heads were approved or allowed on; trust never carries to another base. */
  trustedOn: string;
  /** A head whose trust a retarget dropped, so its next decision re-reads the evidence against the new base. */
  retargeted?: string;
  /** Settle waits cost no ci-wait cycle against the backstop; the settle bound ends them. */
  settles: number;
  /** Merge steps that waited on a hold cost no cycle either: only the owner's release ends that wait, so no count may fail it (TP-4082). */
  helds: number;
  orphanReruns: number;
  /** ci-wait windows in a row that timed out on a wait only GitHub ends. */
  timeouts: number;
  hold: SettleHold;
}

/**
 * Wait for green, keep the branch current, and merge the exact head a human or an allowing policy approved. Returns
 * instead of merging on anything else, so the calling pilot decides what a red CI means.
 */
export async function land(ctx: WorkflowContext, input: LandInput, options: LandOptions): Promise<LandOutcome> {
  const round = input.round ?? 0;
  if (!Number.isInteger(round) || round < 0) throw new Error(`land: round must be a non-negative integer, got ${round}`);
  const rules = await step(ctx, roundId("land-rules", round), { repo: input.repo, pr: input.pr }, LandRulesResult);
  const state: LandState = {
    round, rules, rulesReads: 0, baseChecks: 0, baseWaits: 0, settles: 0, helds: 0, orphanReruns: 0, timeouts: 0, cycle: 0, updates: 0, retries: 0,
    bound: input.updateBound ?? newUpdateBound(), hold: input.settleHold ?? {}, merges: 0, decisions: 0,
    trusted: new Set(), trustedBy: "human", trustedOn: rules.base,
  };
  for (;;) {
    if (state.cycle - state.settles - state.helds >= MAX_CI_CYCLES) throw new Error(`land: PR #${input.pr} did not settle within ${MAX_CI_CYCLES} ci-wait cycles`);
    const ci = await step(ctx, roundId("ci-wait", round, state.cycle++), { repo: input.repo, pr: input.pr, contexts: state.rules.contexts, strict: state.rules.strict }, CiSnapshotResult);
    if (waitsAgain(ci, state)) continue;
    if (ci.orphaned?.length) {
      await rerunOrphaned(ctx, roundId("ci-orphan-rerun", round, state.orphanReruns++), { repo: input.repo, pr: input.pr, headSha: ci.headSha, jobs: ci.orphaned });
      continue;
    }
    if (await rebased(ctx, input, ci, state)) continue;
    if (ci.verdict !== "behind" && retryLanded(state.bound)) restartUpdates(state.bound);
    const settled = landsAsIs(ci) ? { ...ci, verdict: "green" as const } : ci;
    const next = settled.verdict === "behind" ? await onBehind(ctx, input, ci, state) : await onSettled(ctx, input, settled, state, options);
    if (next) return next;
  }
}

/**
 * A green read is confirmed through the port, so a base it names that differs from the rules' base was retargeted:
 * the rules are read again for the new base, and CI is judged on them before anything acts on this read.
 */
async function rebased(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState): Promise<boolean> {
  if (ci.verdict !== "green" || ci.baseRef === undefined || ci.baseRef === state.rules.base) return false;
  state.rules = await step(ctx, roundId("land-rules", state.round, ++state.rulesReads), { repo: input.repo, pr: input.pr }, LandRulesResult);
  return true;
}

/** Round 0 keeps the ids runs recorded before rounds existed; later rounds never share an id with an earlier one. */
function roundId(name: string, round: number, n?: number): string {
  const parts = [name, ...(round === 0 ? [] : [`r${round}`]), ...(n === undefined ? [] : [String(n)])];
  return parts.join(":");
}

/**
 * A repo that does not require up-to-date heads merges a stale green as it stands, as GitHub would. A refresh before
 * the merge restarted CI, and a base that moved during that CI again sent the next round's head back for another
 * (tp#2054 chased main through three green heads). What the merge brings together is judged by main's own CI after it.
 */
function landsAsIs(ci: CiSnapshot): boolean {
  return ci.baseMoved === true;
}

/** Only a strict repo reads a head behind here, so every update spends the bound shared by every round. */
async function onBehind(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState): Promise<LandOutcome | undefined> {
  if (input.update === false) return stopped("behind", ci.headSha, `the base moved past head ${ci.headSha}; it needs a merge-up, and this run may not update the branch`);
  const spent = budgetSpent(state.bound, ci.readAt);
  const retrying = spent && retryBeforeGate(ctx, state.bound);
  if (retrying) await backoff(ctx, state);
  else if (spent) {
    const stopped = await askStuckBehind(ctx, input, ci, state);
    if (stopped) return stopped;
  }
  const update = await step(ctx, roundId("update-branch", state.round, state.updates++), { repo: input.repo, pr: input.pr, expectedHeadSha: ci.headSha }, UpdateResultResult);
  if (retrying) recordRetry(state.bound, ci.headSha);
  else recordUpdate(state.bound, ci.headSha, update.at);
  return afterUpdate(ci, update, state);
}

async function askStuckBehind(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState): Promise<LandOutcome | undefined> {
  const why = stuckBehindReason(state.bound, ci.headSha, ci.readAt);
  const { schema, brief } = stuckBehindDecision({ repo: input.repo, pr: input.pr, headSha: ci.headSha, why });
  const answer = await ctx.assisted("stuck-behind", `PR #${input.pr} in ${input.repo} is ${why}. Retry or abandon?`, { schema, brief });
  if (schema.parse(answer.data).decision === "abandon") return stopped("stuck-behind", ci.headSha, why);
  resetBound(state.bound);
  return undefined;
}

/**
 * Retry before the gate. Where the record continues, it alone decides: only a recorded backoff means retrying. Where the
 * record ends, a run paused on `stuck-behind` (recorded before retries) keeps its pending gate; a live run retries.
 */
function retryBeforeGate(ctx: WorkflowContext, bound: UpdateBound): boolean {
  if (!retriesLeft(bound)) return false;
  const next = ctx.historyNext();
  if (next !== undefined) return next.startsWith("update-backoff");
  return ctx.resumedGate() !== "stuck-behind";
}

/** The recorded wait before a retry; the retry itself is an ordinary `update-branch` step, so every consumer of that step covers it. */
async function backoff(ctx: WorkflowContext, state: LandState): Promise<void> {
  const retry = (state.bound.retries ?? 0) + 1;
  await step(ctx, roundId("update-backoff", state.round, state.retries++), { waitMs: retryBackoffMs(retry - 1), retry }, BackoffResult);
}

/** What follows any update, a retry included: the stops, and the trust a head built on an approved one inherits. */
function afterUpdate(ci: CiSnapshot, update: z.infer<typeof UpdateResultResult>, state: LandState): LandOutcome | undefined {
  if (update.conflict) return stopped("conflict", ci.headSha, "update-branch: merge conflict between base and head");
  if (update.unmoved) return stopped("update-branch-unmoved", ci.headSha, `update-branch: head still ${ci.headSha} after ${UPDATE_RESENDS} re-sends`);
  if (update.own && state.trustedBy === "human" && state.trusted.has(ci.headSha)) state.trusted.add(update.headSha);
  return undefined;
}

async function onSettled(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<LandOutcome | undefined> {
  if (ci.verdict === "red") return { kind: "ci-failed", headSha: ci.headSha, failing: ci.failing ?? [] };
  if (ci.verdict === "merged") return { kind: "merged", headSha: ci.headSha, mergeSha: ci.mergeSha ?? null };
  if (ci.verdict === "closed") return stopped("closed", ci.headSha, "the pull request was closed without merging");
  if (ci.verdict !== "green") return stopped("not-mergeable", ci.headSha, `mergeable_state is ${ci.mergeableState}`);
  if (!state.trusted.has(ci.headSha)) return approve(ctx, input, ci, state, options);
  const check = await allowedBase(ctx, input, ci, state, options);
  if (check === undefined) return undefined;
  const mergeInput = { repo: input.repo, pr: input.pr, sha: ci.headSha, method: input.method ?? "squash", taskIds: input.taskIds ?? [], base: check.base };
  const merge = await step(ctx, roundId("merge", state.round, state.merges++), mergeInput, MergeResultResult);
  return afterMerge(merge, ci, check, state);
}

function afterMerge(merge: z.infer<typeof MergeResultResult>, ci: CiSnapshot, check: BaseCheck, state: LandState): LandOutcome | undefined {
  // The port answers "" for a PR merged elsewhere with no merge commit named.
  if (merge.done || merge.skipped === "merged") {
    return { kind: "merged", headSha: ci.headSha, mergeSha: merge.mergeSha || null, ...landedOf(check, ci.headSha), ...(merge.done && { own: true as const }) };
  }
  if (merge.skipped === "closed") return stopped("closed", ci.headSha, "the pull request was closed before the merge");
  if (merge.skipped === "held") state.helds++;
  return undefined;
}

/**
 * The base check that allowed the approved head's merge, read live; undefined after a wait on a refused base, so land
 * reads CI again. A refused base never reaches the merge step, and the wait neither fails nor ends the run.
 */
async function allowedBase(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<BaseCheck | undefined> {
  const check = await baseCheck(ctx, input, state, options);
  if (check.allowed && check.base !== state.trustedOn) return untrust(state, ci.headSha);
  if (check.allowed) return check;
  await baseWait(ctx, input, ci.headSha, check, state);
  return undefined;
}

async function baseCheck(ctx: WorkflowContext, input: LandInput, state: LandState, options: LandOptions): Promise<BaseCheck> {
  const checkInput: BaseCheckInput = { repo: input.repo, pr: input.pr, featureBase: options.featureBase?.() ?? false };
  return step(ctx, roundId("base-check", state.round, state.baseChecks++), checkInput, BaseCheckResult);
}

async function baseWait(ctx: WorkflowContext, input: LandInput, headSha: string, check: BaseCheck, state: LandState): Promise<void> {
  const waitInput: BaseWaitInput = { repo: input.repo, pr: input.pr, base: check.base, headSha };
  await step(ctx, roundId("base-wait", state.round, state.baseWaits++), waitInput, BaseWaitResult);
}

/**
 * The base the merge would be decided on, checked before the decision so a refused base waits with no gate open. Undefined
 * sends land back to CI: after the wait, or once a base the rules were not read on is allowed and the rules are re-read.
 * A record that continues past CI with no base check predates this one and replays without it. A wait on a refused base
 * marks the head retargeted, as `untrust` does, because the evidence it was read with describes the refused base.
 */
async function decisionBase(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<string | undefined> {
  const next = ctx.historyNext();
  if (next !== undefined && !next.startsWith("base-check")) return ci.baseRef ?? state.rules.base;
  const check = await baseCheck(ctx, input, state, options);
  if (!check.allowed) {
    await baseWait(ctx, input, ci.headSha, check, state);
    state.retargeted = ci.headSha;
    return undefined;
  }
  if (check.base === state.rules.base) return check.base;
  state.rules = await step(ctx, roundId("land-rules", state.round, ++state.rulesReads), { repo: input.repo, pr: input.pr }, LandRulesResult);
  return undefined;
}

/**
 * Settle waits and retargets re-read the evidence, and so does evidence read on another base; then any read the decision on
 * this base still lacks is taken. The last two are newer than some records: one that goes straight on to `merge-policy` was
 * decided without them, so a replay skips them.
 */
async function refreshEvidence(ctx: WorkflowContext, headSha: string, base: string, state: LandState, options: LandOptions): Promise<void> {
  const evidenceBase = options.evidenceBase?.(headSha);
  const next = ctx.historyNext();
  const decidedWithout = next !== undefined && next.startsWith("merge-policy");
  const elsewhere = evidenceBase !== undefined && evidenceBase !== base && !decidedWithout;
  if (state.hold.settle?.headSha === headSha || state.retargeted === headSha || elsewhere) await options.unsettled?.refresh(ctx, headSha);
  if (!decidedWithout) await options.readOn?.(ctx, headSha, base);
  state.retargeted = undefined;
}

/** The payload must name the head shown, so an approval can never carry over to a head the human did not see. */
async function approve(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<LandOutcome | undefined> {
  const base = await decisionBase(ctx, input, ci, state, options);
  if (base === undefined) return undefined;
  if (await mergesBaseFirst(ctx, input, { headSha: ci.headSha, base }, options)) return mergeBase(ctx, input, ci, state);
  await refreshEvidence(ctx, ci.headSha, base, state, options);
  const decided = await decideMerge(ctx, input, ci, state, options);
  if (decided.outcome === "deny") return stopped("merge-denied", ci.headSha, decided.reason);
  if (decided.outcome === "allow") return void trust(state, ci.headSha, "policy", base);
  if (await mergesBaseFirst(ctx, input, { headSha: ci.headSha, base, reason: decided.reason }, options)) return mergeBase(ctx, input, ci, state);
  const settleStep = (wait: Omit<SettleInput, "repo" | "baseRef">) =>
    step(ctx, roundId("merge-settle", state.round, state.settles++), { repo: input.repo, baseRef: state.rules.base, ...wait }, SettleResult);
  const decision = gatedOnRecord(ctx) ? decided : await settleOrGate(state.hold, decided, options.unsettled, ci.headSha, settleStep);
  if (!decision) return undefined;
  const ask = options.askApproval ?? approveMergeGate(decision.rule, options);
  return askedApproval(ctx, ask, { repo: input.repo, pr: input.pr, headSha: ci.headSha, round: state.round, reason: decision.reason, base }, (by) => trust(state, ci.headSha, by, base));
}

/** A run that may not update the branch never merges the base on the hook's word either. */
async function mergesBaseFirst(ctx: WorkflowContext, input: LandInput, at: MergeBaseAsk, options: LandOptions): Promise<boolean> {
  return input.update !== false && options.mergeBaseFirst !== undefined && (await options.mergeBaseFirst(ctx, at));
}

/** TP-4691: the hook's merge of the base is an ordinary update-branch step, so every reader of that step covers it. */
async function mergeBase(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState): Promise<LandOutcome | undefined> {
  const update = await step(ctx, roundId("update-branch", state.round, state.updates++), { repo: input.repo, pr: input.pr, expectedHeadSha: ci.headSha }, UpdateResultResult);
  return afterUpdate(ci, update, state);
}

/**
 * A record that goes from its gated decision straight to the ask was made before that gate waited at its head (a freeze
 * or missing facts, TP-3734), so a replay asks as it did.
 */
function gatedOnRecord(ctx: WorkflowContext): boolean {
  const next = ctx.historyNext();
  return next !== undefined && !next.startsWith("merge-settle");
}

/** The recorded decision, not a fresh `decide`, drives the branch: a replay must not flip a gate to an allow. */
async function decideMerge(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<GateDecision> {
  const decision = options.policy.decide("merge", { headSha: ci.headSha });
  const evidence = decision.outcome === "allow" ? (options.allowEvidence?.({ repo: input.repo, pr: input.pr, headSha: ci.headSha, decision }) ?? {}) : undefined;
  const recorded = await step(ctx, roundId("merge-policy", state.round, state.decisions++), { headSha: ci.headSha, decision, evidence }, MergePolicyResult);
  if (recorded.headSha !== ci.headSha) throw new Error(`merge-policy recorded head ${recorded.headSha}, expected ${ci.headSha}`);
  return { outcome: recorded.outcome, rule: recorded.rule, reason: recorded.reason };
}

function trust(state: LandState, headSha: string, by: LandState["trustedBy"], base: string): void {
  state.trusted = new Set([headSha]);
  state.trustedBy = by;
  state.trustedOn = base;
  if (by === "human") resetBound(state.bound);
}

/** An approval or a policy allow judged one base never covers another, so a retargeted head is decided again. */
function untrust(state: LandState, headSha: string): undefined {
  state.trusted = new Set();
  state.retargeted = headSha;
  return undefined;
}

function stopped(reason: Extract<LandOutcome, { kind: "stopped" }>["reason"], headSha: string, detail: string): LandOutcome {
  return { kind: "stopped", reason, headSha, detail };
}

/** Code steps take their input as JSON and answer with one evidence record whose `result` the workflow reads. */
export function step<R>(ctx: WorkflowContext, stepId: string, input: object, result: z.ZodType<R>): Promise<R> {
  return codeStep(ctx, stepId, input, result);
}
