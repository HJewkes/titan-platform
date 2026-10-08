import type { GitHubPort, MergeMethod, RepoSlug } from "@titan-design/github";
import type { RoutedStepInput, StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { TRACE_DATA_KEYS, evidenceRecord, traceRef } from "../evidence.js";
import { approveMergeDecision, stuckBehindDecision } from "../gate-brief.js";
import { policyTraceGate, type GateDecision, type GatePolicy } from "../gate-policy.js";
import { requireRequiredChecks } from "../required-checks.js";
import { redactForEvidence } from "../redact.js";
import { deadline } from "./deadline.js";
import { holdOpenGreen } from "./land-open-checks.js";
import { readCi, type CiInput, type CiSnapshot, type FailingCheck } from "./land-ci.js";
import { CI_BACKLOG_CEILING_FACTOR, MISSING_CHECK_GRACE_MS, budgetSpent, missingCheckGraceSpent, recordRetry, retriesLeft, retryBackoffMs, restartUpdates, retryLanded, newUpdateBound, recordUpdate, resetBound, stuckBehindReason, type FirstReads, type UpdateBound } from "./land-budget.js";
import { flakyState, rerunIfFlaky, type FlakyChecks, type FlakyState } from "./land-flaky.js";
import { SettleResult, settleOrGate, settleRun, type MergeTreeProbe, type SettleHold, type SettleInput, type UnsettledMerge } from "./land-settle.js";
import { UPDATE_RESENDS, updateBranch, type UpdateInput } from "./land-update.js";
import type { PrSnapshot } from "./pr-snapshot.js";
import { baseMovedOrThrow, CiSnapshotResult, LandRulesResult, BackoffResult, MergePolicyResult, MergeResultResult, UpdateResultResult } from "./land-steps.js";

export { readCi, type CiSnapshot, type FailingCheck } from "./land-ci.js";
export { CI_BACKLOG_CEILING_FACTOR, MAX_UPDATE_CYCLES, MAX_UPDATE_RETRIES, MISSING_CHECK_GRACE_MS, UPDATE_BUDGET_MS, newUpdateBound, type UpdateBound } from "./land-budget.js";

/** A backstop: every legitimate loop passes a gate or the update bound long before this. */
export const MAX_CI_CYCLES = 20;

/** Every step the land core calls; a workflow that uses `land` spreads these into its own declaration. */
export const LAND_STEPS: readonly StepDeclaration[] = [
  { id: "land-rules", kind: "dispatch" },
  { id: "ci-wait", kind: "dispatch" },
  { id: "update-branch", kind: "dispatch" },
  { id: "update-backoff", kind: "dispatch" },
  { id: "merge", kind: "dispatch" },
  { id: "merge-policy", kind: "dispatch" },
  { id: "merge-settle", kind: "dispatch" },
  { id: "approve-merge", kind: "assisted" },
  { id: "stuck-behind", kind: "assisted" },
];

const INPUT_VAR = "LAND_STEP_INPUT";
const TEMPLATE = `{{${INPUT_VAR}}}`;

export interface LandInput {
  repo: RepoSlug;
  pr: number;
  method?: MergeMethod;
  /** Which entry into `land` this is within one run; a pilot that re-enters after a rerun or a new head passes the next round. */
  round?: number;
  /** Updates since the last human gate, counted across every round of the run; a caller that re-enters `land` passes the same bound each time. */
  updateBound?: UpdateBound;
  /** The unsettled-merge wait at a head across every round of the run; a caller that re-enters `land` passes the same hold each time. */
  settleHold?: SettleHold;
}

/** What an `allowEvidence` hook learns about the merge the policy allowed. */
export interface MergeAllowContext {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  decision: GateDecision;
}

export interface LandOptions {
  /**
   * Consulted with the head before each merge of an untrusted head, and the decision is recorded in a `merge-policy`
   * step before any branch, so a replay reuses it. `gate` asks the owner through `approve-merge`, `deny` stops
   * `merge-denied`, and `allow` trusts that one head with no hitl gate, because hitl refuses every automation resolver.
   */
  policy: GatePolicy;
  /** Evidence the allowing caller vouches for, stored beside the policy trace in the `merge-policy` step. */
  allowEvidence?: (merge: MergeAllowContext) => Record<string, unknown>;
  /** True when the reviewer's verdict at exactly this head is MERGE; only then does the approve-merge brief recommend merging. */
  reviewedMerge?: (headSha: string) => boolean;
  /** A gate this names waits at its head on recorded backoff steps, refreshing the facts each time, before the owner is asked. */
  unsettled?: UnsettledMerge;
}

export type LandOutcome =
  /** `mergeSha` is null when GitHub reports the PR merged but names no merge commit. */
  | { kind: "merged"; headSha: string; mergeSha: string | null }
  | { kind: "ci-failed"; headSha: string; failing: FailingCheck[] }
  | { kind: "stopped"; reason: "closed" | "not-mergeable" | "conflict" | "abandoned" | "stuck-behind" | "merge-denied" | "update-branch-unmoved"; headSha: string; detail: string };

export interface LandDeps {
  port: GitHubPort;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  ciTimeoutMs?: number;
  /** How long a strict behind head waits on a required check that never reported before it is updated; default `MISSING_CHECK_GRACE_MS`. */
  missingCheckGraceMs?: number;
  updateTimeoutMs?: number;
  flakyChecks?: Record<string, FlakyChecks>;
  /** Where `ci-wait` reads the PR and its checks; absent means the port, once per poll. Writes always re-read through the port. */
  snapshot?: PrSnapshot;
  /** Probes the local merge-tree when an unsettled merge outlasts its bound; absent means the gate says it was not run. */
  mergeTree?: MergeTreeProbe;
}

interface LandRules {
  base: string;
  contexts: string[];
  strict: boolean;
}

interface LandState {
  round: number;
  base: string;
  cycle: number;
  updates: number;
  retries: number;
  bound: UpdateBound;
  merges: number;
  decisions: number;
  /** Heads a resolved approve-merge gate covers: the approved head plus heads this run's updates built on it. */
  trusted: Set<string>;
  /** A policy allow covers only the head it named, so this run's updates never extend it. */
  trustedBy: "human" | "policy";
  /** Heads this round's own update made from a stale green in a non-strict repo: each is the refresh its merge needs. */
  refreshed: Set<string>;
  /** Settle waits cost no ci-wait cycle against the backstop; the settle bound ends them. */
  settles: number;
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
  const state: LandState = { round, base: rules.base, settles: 0, cycle: 0, updates: 0, retries: 0, bound: input.updateBound ?? newUpdateBound(), hold: input.settleHold ?? {}, merges: 0, decisions: 0, trusted: new Set(), trustedBy: "human", refreshed: new Set() };
  for (;;) {
    if (state.cycle - state.settles >= MAX_CI_CYCLES) throw new Error(`land: PR #${input.pr} did not settle within ${MAX_CI_CYCLES} ci-wait cycles`);
    const ci = await step(ctx, roundId("ci-wait", round, state.cycle++), { repo: input.repo, pr: input.pr, contexts: rules.contexts, strict: rules.strict }, CiSnapshotResult);
    if (ci.verdict !== "behind" && retryLanded(state.bound)) restartUpdates(state.bound);
    const settled = landsAsIs(ci, state) ? { ...ci, verdict: "green" as const } : ci;
    const next = settled.verdict === "behind" ? await onBehind(ctx, input, ci, state) : await onSettled(ctx, input, settled, state, options);
    if (next) return next;
  }
}

/** Round 0 keeps the ids runs recorded before rounds existed; later rounds never share an id with an earlier one. */
function roundId(name: string, round: number, n?: number): string {
  const parts = [name, ...(round === 0 ? [] : [`r${round}`]), ...(n === undefined ? [] : [String(n)])];
  return parts.join(":");
}

/**
 * A repo that does not require up-to-date heads treats a stale green as green until the merge is approved, then
 * refreshes the approved head once against the base it will merge into. The refresh belongs to the head it made, not
 * to the run's update count, so a later head is refreshed again; a base that moves after the refresh does not loop it.
 */
function landsAsIs(ci: CiSnapshot, state: LandState): boolean {
  return ci.baseMoved === true && (!state.trusted.has(ci.headSha) || state.refreshed.has(ci.headSha));
}

/**
 * A strict repo's update spends the bound shared by every round. A non-strict repo's pre-merge refresh stays out of it:
 * `refreshed` lets each approved head refresh once, so that path cannot loop and never reaches stuck-behind.
 */
async function onBehind(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState): Promise<LandOutcome | undefined> {
  const refresh = ci.baseMoved === true;
  const spent = !refresh && budgetSpent(state.bound, ci.readAt);
  const retrying = spent && retryBeforeGate(ctx, state.bound);
  if (retrying) await backoff(ctx, state);
  else if (spent) {
    const stopped = await askStuckBehind(ctx, input, ci, state);
    if (stopped) return stopped;
  }
  const update = await step(ctx, roundId("update-branch", state.round, state.updates++), { repo: input.repo, pr: input.pr, expectedHeadSha: ci.headSha }, UpdateResultResult);
  if (retrying) recordRetry(state.bound, ci.headSha);
  else if (!refresh) recordUpdate(state.bound, ci.headSha, update.at);
  return afterUpdate(ci, update, state, refresh);
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
function afterUpdate(ci: CiSnapshot, update: z.infer<typeof UpdateResultResult>, state: LandState, refresh: boolean): LandOutcome | undefined {
  if (update.conflict) return stopped("conflict", ci.headSha, "update-branch: merge conflict between base and head");
  if (update.unmoved) return stopped("update-branch-unmoved", ci.headSha, `update-branch: head still ${ci.headSha} after ${UPDATE_RESENDS} re-sends`);
  if (update.own && state.trustedBy === "human" && state.trusted.has(ci.headSha)) state.trusted.add(update.headSha);
  if (update.own && refresh) state.refreshed.add(update.headSha);
  return undefined;
}

async function onSettled(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<LandOutcome | undefined> {
  if (ci.verdict === "red") return { kind: "ci-failed", headSha: ci.headSha, failing: ci.failing ?? [] };
  if (ci.verdict === "merged") return { kind: "merged", headSha: ci.headSha, mergeSha: ci.mergeSha ?? null };
  if (ci.verdict === "closed") return stopped("closed", ci.headSha, "the pull request was closed without merging");
  if (ci.verdict !== "green") return stopped("not-mergeable", ci.headSha, `mergeable_state is ${ci.mergeableState}`);
  if (!state.trusted.has(ci.headSha)) return approve(ctx, input, ci, state, options);
  const merge = await step(ctx, roundId("merge", state.round, state.merges++), { repo: input.repo, pr: input.pr, sha: ci.headSha, method: input.method ?? "squash" }, MergeResultResult);
  // The port answers "" for a PR merged elsewhere with no merge commit named.
  if (merge.done || merge.skipped === "merged") return { kind: "merged", headSha: ci.headSha, mergeSha: merge.mergeSha || null };
  if (merge.skipped === "closed") return stopped("closed", ci.headSha, "the pull request was closed before the merge");
  return undefined;
}

/** The payload must name the head shown, so an approval can never carry over to a head the human did not see. */
async function approve(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<LandOutcome | undefined> {
  if (state.hold.settle?.headSha === ci.headSha) await options.unsettled?.refresh(ctx, ci.headSha);
  const decided = await decideMerge(ctx, input, ci, state, options);
  if (decided.outcome === "deny") return stopped("merge-denied", ci.headSha, decided.reason);
  if (decided.outcome === "allow") return void trust(state, ci.headSha, "policy");
  const settleStep = (wait: Omit<SettleInput, "repo" | "baseRef">) => step(ctx, roundId("merge-settle", state.round, state.settles++), { repo: input.repo, baseRef: state.base, ...wait }, SettleResult);
  const decision = await settleOrGate(state.hold, decided, options.unsettled, ci.headSha, settleStep);
  if (!decision) return undefined;
  const reviewedMerge = options.reviewedMerge?.(ci.headSha) ?? false;
  const { schema, brief } = approveMergeDecision({ repo: input.repo, pr: input.pr, headSha: ci.headSha, reason: decision.reason, reviewedMerge });
  const prompt = `Merge PR #${input.pr} in ${input.repo} at head ${ci.headSha}? CI is green. Policy ${decision.rule.table}/${decision.rule.rowId}: ${decision.reason}`;
  const answer = schema.safeParse((await ctx.assisted("approve-merge", prompt, { schema, brief })).data);
  if (!answer.success) throw new Error(`approve-merge answer does not approve head ${ci.headSha}: ${answer.error.message}`);
  if (answer.data.decision === "abandon") return stopped("abandoned", ci.headSha, "a human declined the merge");
  trust(state, ci.headSha, "human");
  return undefined;
}

/** The recorded decision, not a fresh `decide`, drives the branch: a replay must not flip a gate to an allow. */
async function decideMerge(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<GateDecision> {
  const decision = options.policy.decide("merge", { headSha: ci.headSha });
  const evidence = decision.outcome === "allow" ? (options.allowEvidence?.({ repo: input.repo, pr: input.pr, headSha: ci.headSha, decision }) ?? {}) : undefined;
  const recorded = await step(ctx, roundId("merge-policy", state.round, state.decisions++), { headSha: ci.headSha, decision, evidence }, MergePolicyResult);
  if (recorded.headSha !== ci.headSha) throw new Error(`merge-policy recorded head ${recorded.headSha}, expected ${ci.headSha}`);
  return { outcome: recorded.outcome, rule: recorded.rule, reason: recorded.reason };
}

function trust(state: LandState, headSha: string, by: LandState["trustedBy"]): void {
  state.trusted = new Set([headSha]);
  state.trustedBy = by;
  if (by === "human") resetBound(state.bound);
}

function stopped(reason: Extract<LandOutcome, { kind: "stopped" }>["reason"], headSha: string, detail: string): LandOutcome {
  return { kind: "stopped", reason, headSha, detail };
}

/** Code steps take their input as JSON and answer with one evidence record whose `result` the workflow reads. */
export async function step<R>(ctx: WorkflowContext, stepId: string, input: object, result: z.ZodType<R>): Promise<R> {
  const done = await ctx.dispatch(stepId, TEMPLATE, { vars: { [INPUT_VAR]: JSON.stringify(input) }, schema: z.looseObject({ result }) });
  return done.data!.result;
}

/** Every land step is a code step that reads before it writes, so each is safe to repeat after a crash. */
export function landRoutes(deps: LandDeps): StepRoute[] {
  const now = deps.now ?? Date.now;
  const timing = { now, sleep: deps.sleep ?? sleep, pollMs: deps.pollMs ?? 30_000 };
  const flaky = flakyState(deps.flakyChecks);
  const firstReads: FirstReads = new Map();
  return [
    codeRoute("land-rules", now, (input: { repo: string; pr: number }) => readRules(deps.port, input)),
    codeRoute("ci-wait", now, (input: CiInput, signal) => waitForCi(deps, input, { ...timing, timeoutMs: deps.ciTimeoutMs ?? 45 * 60_000 }, signal, flaky, firstReads)),
    codeRoute("update-branch", now, updateRun(deps, timing, now)),
    codeRoute("update-backoff", now, async (input: { waitMs: number; retry: number }, signal) => (await timing.sleep(input.waitMs, signal), input)),
    codeRoute("merge", now, async (input: MergeInput) => afterWrite(deps, input, deps.port.merge(input.repo, input.pr, input.sha, input.method).catch(baseMovedOrThrow))),
    recordRoute("merge-policy", now, async (input: MergePolicyInput, step) => mergePolicyRecord(input, step)),
    codeRoute("merge-settle", now, (input: SettleInput, signal) => settleRun(input, timing, deps.mergeTree, signal)),
  ];
}

function updateRun(deps: LandDeps, timing: Omit<Timing, "timeoutMs">, now: () => number) {
  return async (input: UpdateInput, signal: AbortSignal) => ({ ...(await afterWrite(deps, input, updateBranch(deps.port, input, { ...timing, timeoutMs: deps.updateTimeoutMs ?? 5 * 60_000 }, signal))), at: now() });
}

export function codeRoute<I>(match: string, now: () => number, fn: (input: I, signal: AbortSignal) => Promise<object>): StepRoute {
  return recordRoute(match, now, async (input: I, step) => ({ result: await fn(input, step.signal) }));
}

/** Like `codeRoute`, for a step whose record carries trace keys beside `result`. */
function recordRoute<I>(match: string, now: () => number, fn: (input: I, step: RoutedStepInput) => Promise<object>): StepRoute {
  const run = async (step: RoutedStepInput) => {
    try {
      const body = await fn(JSON.parse(step.prompt) as I, step);
      const record = evidenceRecord(`land.${match}`, step, new Date(now()).toISOString(), body);
      return { ok: true as const, output: JSON.stringify(record) };
    } catch (error) {
      return { ok: false as const, error: redactForEvidence(error instanceof Error ? error.message : String(error)), retryable: false };
    }
  };
  return { match, onRestart: "repeat", runner: { run } };
}

async function readRules(port: GitHubPort, input: { repo: string; pr: number }): Promise<LandRules> {
  const pr = await port.getPr(input.repo, input.pr);
  const required = await requireRequiredChecks(port, input.repo, pr.baseRef);
  return { base: pr.baseRef, contexts: required.contexts, strict: required.strict };
}

export interface Timing {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
}

/** Writes go through the port, which re-reads the PR first; the snapshot is dropped once a write is through, so the next read sees it. */
export async function afterWrite<T>(deps: LandDeps, input: { repo: string }, write: Promise<T>): Promise<T> {
  try {
    return await write;
  } finally {
    deps.snapshot?.invalidate(input.repo);
  }
}

/** One blocking step: the workflow retry loop has no backoff, so polling lives here. A failed read is polled again. */
async function waitForCi(deps: LandDeps, input: CiInput, timing: Timing, signal: AbortSignal, flaky: FlakyState, firstReads: FirstReads): Promise<CiSnapshot> {
  const { port, snapshot: reads } = deps;
  const clock = deadline(timing);
  const startedAt = timing.now();
  let backlog = false;
  const graceMs = deps.missingCheckGraceMs ?? MISSING_CHECK_GRACE_MS;
  const missingSettled = (headSha: string) => missingCheckGraceSpent(firstReads, `${input.repo}#${input.pr}@${headSha}`, timing.now(), graceMs);
  let last = "no read yet";
  const holdGreen = holdOpenGreen();
  for (;;) {
    try {
      const snapshot = holdGreen(await readCi(port, input, reads, { missingSettled }));
      if (snapshot.verdict === "red" && (await afterWrite(deps, input, rerunIfFlaky(port, input, snapshot, timing, signal, flaky)))) continue;
      if (snapshot.verdict !== "pending") return { ...snapshot, readAt: timing.now() };
      last = `waiting on ${snapshot.waitingOn?.join(", ") || `mergeable_state ${snapshot.mergeableState}`}`;
      backlog = snapshot.backlog === true;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      backlog = false;
    }
    if (clock.expired()) {
      const ceilingMs = timing.timeoutMs * CI_BACKLOG_CEILING_FACTOR;
      if (!backlog) throw new Error(`ci-wait timed out after ${timing.timeoutMs} ms: ${last}`);
      if (timing.now() - startedAt >= ceilingMs) throw new Error(`ci-wait gave up after ${ceilingMs} ms on a CI backlog: checks still queued or running, none red; ${last}`);
    }
    await clock.sleep(timing.pollMs, signal);
  }
}

interface MergePolicyInput {
  headSha: string;
  decision: GateDecision;
  evidence?: Record<string, unknown>;
}

function mergePolicyRecord(input: MergePolicyInput, step: RoutedStepInput): object {
  const { outcome, rule, reason } = input.decision;
  const trace = { [TRACE_DATA_KEYS.gates]: [policyTraceGate(input.decision, traceRef(step))] };
  return { result: { outcome, headSha: input.headSha, rule, reason }, ...(input.evidence ? { allowEvidence: input.evidence } : {}), ...trace };
}

interface MergeInput {
  repo: string;
  pr: number;
  sha: string;
  method: MergeMethod;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => (signal.removeEventListener("abort", abort), resolve()), ms);
    const abort = () => (clearTimeout(timer), reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
  });
}
