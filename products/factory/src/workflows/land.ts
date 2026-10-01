import { GITHUB_ACTIONS_APP_ID, headCheckFindings, latestPerName, type CheckFinding, type CheckRun, type GitHubPort, type MergeMethod, type PullRequest, type RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { TRACE_DATA_KEYS, evidenceRecord, traceRef } from "../evidence.js";
import { policyTraceGate, type GateDecision, type GatePolicy } from "../gate-policy.js";
import { requireRequiredChecks } from "../required-checks.js";
import { redactForEvidence } from "../redact.js";
import type { RoutedStepInput, StepRoute } from "../routed-runner.js";
import { deadline } from "./deadline.js";
import { CiSnapshotResult, LandRulesResult, MergePolicyResult, MergeResultResult, UpdateResultResult } from "./land-steps.js";

/** Update cycles allowed before the run asks a human whether to keep chasing the base. */
export const MAX_UPDATE_CYCLES = 3;

/** A backstop: every legitimate loop passes a gate or the update bound long before this. */
export const MAX_CI_CYCLES = 20;

/** Every step the land core calls; a workflow that uses `land` spreads these into its own declaration. */
export const LAND_STEPS: readonly StepDeclaration[] = [
  { id: "land-rules", kind: "dispatch" },
  { id: "ci-wait", kind: "dispatch" },
  { id: "update-branch", kind: "dispatch" },
  { id: "merge", kind: "dispatch" },
  { id: "merge-policy", kind: "dispatch" },
  { id: "approve-merge", kind: "assisted" },
  { id: "stuck-behind", kind: "assisted" },
];

/** mergeable_state values that let a merge through; `unknown` and `blocked` mean GitHub has not settled. */
const MERGEABLE = new Set(["clean", "unstable", "has_hooks"]);
const INPUT_VAR = "LAND_STEP_INPUT";
const TEMPLATE = `{{${INPUT_VAR}}}`;

export interface LandInput {
  repo: RepoSlug;
  pr: number;
  method?: MergeMethod;
  /** Which entry into `land` this is within one run; a pilot that re-enters after a rerun or a new head passes the next round. */
  round?: number;
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
}

export interface FailingCheck {
  name: string;
  conclusion: string | null;
  url: string;
  workflowRunId: number | null;
}

export type LandOutcome =
  | { kind: "merged"; headSha: string; mergeSha: string }
  | { kind: "ci-failed"; headSha: string; failing: FailingCheck[] }
  | { kind: "stopped"; reason: "closed" | "not-mergeable" | "abandoned" | "stuck-behind" | "merge-denied"; headSha: string; detail: string };

export interface LandDeps {
  port: GitHubPort;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  ciTimeoutMs?: number;
  updateTimeoutMs?: number;
}

interface LandRules {
  base: string;
  contexts: string[];
  strict: boolean;
}

type CiVerdict = "pending" | "green" | "red" | "behind" | "merged" | "closed" | "not-mergeable";

export interface CiSnapshot {
  verdict: CiVerdict;
  headSha: string;
  mergeableState: string;
  mergeSha?: string | null;
  failing?: FailingCheck[];
  waitingOn?: string[];
}

interface UpdateResult {
  headSha: string;
  /** The new head is GitHub's merge of the expected head and the base, so it adds nothing a human has not seen. */
  own: boolean;
  skipped?: string;
}

interface LandState {
  round: number;
  cycle: number;
  updates: number;
  updatesSinceGate: number;
  merges: number;
  decisions: number;
  /** Heads a resolved approve-merge gate covers: the approved head plus heads this run's updates built on it. */
  trusted: Set<string>;
  /** A policy allow covers only the head it named, so this run's updates never extend it. */
  trustedBy: "human" | "policy";
}

/**
 * Wait for green, keep the branch current, and merge the exact head a human or an allowing policy approved. Returns
 * instead of merging on anything else, so the calling pilot decides what a red CI means.
 */
export async function land(ctx: WorkflowContext, input: LandInput, options: LandOptions): Promise<LandOutcome> {
  const round = input.round ?? 0;
  if (!Number.isInteger(round) || round < 0) throw new Error(`land: round must be a non-negative integer, got ${round}`);
  const rules = await step(ctx, roundId("land-rules", round), { repo: input.repo, pr: input.pr }, LandRulesResult);
  const state: LandState = { round, cycle: 0, updates: 0, updatesSinceGate: 0, merges: 0, decisions: 0, trusted: new Set(), trustedBy: "human" };
  for (;;) {
    if (state.cycle >= MAX_CI_CYCLES) throw new Error(`land: PR #${input.pr} did not settle within ${MAX_CI_CYCLES} ci-wait cycles`);
    const ci = await step(ctx, roundId("ci-wait", round, state.cycle++), { repo: input.repo, pr: input.pr, contexts: rules.contexts, strict: rules.strict }, CiSnapshotResult);
    const next = ci.verdict === "behind" ? await onBehind(ctx, input, ci, state) : await onSettled(ctx, input, ci, state, options);
    if (next) return next;
  }
}

/** Round 0 keeps the ids runs recorded before rounds existed; later rounds never share an id with an earlier one. */
function roundId(name: string, round: number, n?: number): string {
  const parts = [name, ...(round === 0 ? [] : [`r${round}`]), ...(n === undefined ? [] : [String(n)])];
  return parts.join(":");
}

async function onBehind(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState): Promise<LandOutcome | undefined> {
  if (state.updatesSinceGate >= MAX_UPDATE_CYCLES) {
    const answer = await ctx.assisted("stuck-behind", `PR #${input.pr} in ${input.repo} is still behind its base after ${MAX_UPDATE_CYCLES} updates. Retry or abandon?`, { schema: StuckBehindAnswer });
    if (StuckBehindAnswer.parse(answer.data).decision === "abandon") return stopped("stuck-behind", ci.headSha, `behind after ${state.updates} updates`);
    state.updatesSinceGate = 0;
  }
  const update = await step(ctx, roundId("update-branch", state.round, state.updates++), { repo: input.repo, pr: input.pr, expectedHeadSha: ci.headSha }, UpdateResultResult);
  state.updatesSinceGate += 1;
  if (update.own && state.trustedBy === "human" && state.trusted.has(ci.headSha)) state.trusted.add(update.headSha);
  return undefined;
}

async function onSettled(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<LandOutcome | undefined> {
  if (ci.verdict === "red") return { kind: "ci-failed", headSha: ci.headSha, failing: ci.failing ?? [] };
  if (ci.verdict === "merged") return { kind: "merged", headSha: ci.headSha, mergeSha: ci.mergeSha ?? "" };
  if (ci.verdict === "closed") return stopped("closed", ci.headSha, "the pull request was closed without merging");
  if (ci.verdict !== "green") return stopped("not-mergeable", ci.headSha, `mergeable_state is ${ci.mergeableState}`);
  if (!state.trusted.has(ci.headSha)) return approve(ctx, input, ci, state, options);
  const merge = await step(ctx, roundId("merge", state.round, state.merges++), { repo: input.repo, pr: input.pr, sha: ci.headSha, method: input.method ?? "squash" }, MergeResultResult);
  if (merge.done || merge.skipped === "merged") return { kind: "merged", headSha: ci.headSha, mergeSha: merge.mergeSha };
  if (merge.skipped === "closed") return stopped("closed", ci.headSha, "the pull request was closed before the merge");
  return undefined;
}

function approveMergeAnswer(headSha: string) {
  return z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.literal(headSha) });
}

const StuckBehindAnswer = z.object({ decision: z.enum(["retry", "abandon"]) });

/** The payload must name the head shown, so an approval can never carry over to a head the human did not see. */
async function approve(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<LandOutcome | undefined> {
  const decision = await decideMerge(ctx, input, ci, state, options);
  if (decision.outcome === "deny") return stopped("merge-denied", ci.headSha, decision.reason);
  if (decision.outcome === "allow") return void trust(state, ci.headSha, "policy");
  const schema = approveMergeAnswer(ci.headSha);
  const prompt = `Merge PR #${input.pr} in ${input.repo} at head ${ci.headSha}? CI is green. Policy ${decision.rule.table}/${decision.rule.rowId}: ${decision.reason}`;
  const answer = schema.safeParse((await ctx.assisted("approve-merge", prompt, { schema })).data);
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

/** Only a human answer restarts the update count; an allow per head must not let a racing base loop unasked. */
function trust(state: LandState, headSha: string, by: LandState["trustedBy"]): void {
  state.trusted = new Set([headSha]);
  state.trustedBy = by;
  if (by === "human") state.updatesSinceGate = 0;
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
  return [
    codeRoute("land-rules", now, (input: { repo: string; pr: number }) => readRules(deps.port, input)),
    codeRoute("ci-wait", now, (input: CiInput, signal) => waitForCi(deps.port, input, { ...timing, timeoutMs: deps.ciTimeoutMs ?? 45 * 60_000 }, signal)),
    codeRoute("update-branch", now, (input: UpdateInput, signal) => updateBranch(deps.port, input, { ...timing, timeoutMs: deps.updateTimeoutMs ?? 5 * 60_000 }, signal)),
    codeRoute("merge", now, (input: MergeInput) => deps.port.merge(input.repo, input.pr, input.sha, input.method)),
    recordRoute("merge-policy", now, async (input: MergePolicyInput, step) => mergePolicyRecord(input, step)),
  ];
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
  if (required.contexts.length === 0) throw new Error(`${input.repo}@${pr.baseRef} requires no status checks; land waits on required checks only, so it refuses`);
  return { base: pr.baseRef, contexts: required.contexts, strict: required.strict };
}

interface Timing {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
}

interface CiInput {
  repo: string;
  pr: number;
  contexts: string[];
  strict: boolean;
}

/** One blocking step: the workflow retry loop has no backoff, so polling lives here. A failed read is polled again. */
async function waitForCi(port: GitHubPort, input: CiInput, timing: Timing, signal: AbortSignal): Promise<CiSnapshot> {
  const clock = deadline(timing);
  let last = "no read yet";
  for (;;) {
    try {
      const snapshot = await readCi(port, input);
      if (snapshot.verdict !== "pending") return snapshot;
      last = `waiting on ${snapshot.waitingOn?.join(", ") || `mergeable_state ${snapshot.mergeableState}`}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (clock.expired()) throw new Error(`ci-wait timed out after ${timing.timeoutMs} ms: ${last}`);
    await clock.sleep(timing.pollMs, signal);
  }
}

export async function readCi(port: GitHubPort, input: CiInput): Promise<CiSnapshot> {
  const pr = await port.getPr(input.repo, input.pr);
  const base = { headSha: pr.headSha, mergeableState: pr.mergeableState };
  if (pr.merged) return { ...base, verdict: "merged", mergeSha: pr.mergeSha };
  if (pr.state === "closed") return { ...base, verdict: "closed" };
  if ((input.strict && pr.behind) || pr.mergeableState === "behind") return { ...base, verdict: "behind" };
  const runs = await port.checkRuns(input.repo, pr.headSha);
  const findings = headCheckFindings({ headSha: pr.headSha, contexts: input.contexts, runs, requiredApps: [GITHUB_ACTIONS_APP_ID] });
  const failing = findings.flatMap((finding) => (finding.kind === "failed" ? [failingCheck(finding.run)] : []));
  if (failing.length > 0) return { ...base, verdict: "red", failing };
  if (findings.length > 0) return { ...base, verdict: "pending", waitingOn: findings.map(findingName) };
  const verdict = mergeVerdict(pr);
  if (verdict === "green" && pr.behind && (await baseMovedSinceGreen(port, input, pr, runs))) return { ...base, verdict: "behind" };
  return { ...base, verdict };
}

/** Reached only when rules are not strict: GitHub would merge this behind head untested against base commits newer than its green. */
async function baseMovedSinceGreen(port: GitHubPort, input: CiInput, pr: PullRequest, runs: CheckRun[]): Promise<boolean> {
  const tip = await port.getHeadSha(input.repo, pr.baseRef);
  if (!tip) return true;
  const committedAt = Date.parse((await port.getCommit(input.repo, tip)).committedAt ?? "");
  const greenAt = greenStartedAt(runs, pr.headSha, input.contexts);
  return Number.isNaN(committedAt) || greenAt === null || committedAt > greenAt;
}

/** The earliest start among the required runs that made the head green; a pull_request run tests the base as it stood then. */
function greenStartedAt(runs: CheckRun[], headSha: string, contexts: string[]): number | null {
  const required = runs.filter((run) => run.headSha === headSha && run.appId === GITHUB_ACTIONS_APP_ID && contexts.includes(run.name));
  const starts = latestPerName(required).map((run) => Date.parse(run.startedAt ?? ""));
  if (starts.length === 0 || starts.some(Number.isNaN)) return null;
  return Math.min(...starts);
}

function failingCheck(run: CheckRun): FailingCheck {
  return { name: run.name, conclusion: run.conclusion, url: run.url, workflowRunId: run.workflowRunId };
}

function findingName(finding: CheckFinding): string {
  return finding.kind === "missing" ? finding.name : finding.run.name;
}

function mergeVerdict(pr: PullRequest): CiVerdict {
  if (pr.draft || pr.mergeableState === "dirty") return "not-mergeable";
  return MERGEABLE.has(pr.mergeableState) ? "green" : "pending";
}

interface UpdateInput {
  repo: string;
  pr: number;
  expectedHeadSha: string;
}

/** update-branch is asynchronous on GitHub, so the step waits for the head to move before it reports one. */
async function updateBranch(port: GitHubPort, input: UpdateInput, timing: Timing, signal: AbortSignal): Promise<UpdateResult> {
  const write = await port.updateBranch(input.repo, input.pr, input.expectedHeadSha);
  if (!write.done && write.skipped !== "head-moved") {
    const pr = await port.getPr(input.repo, input.pr);
    return { headSha: pr.headSha, own: pr.headSha === input.expectedHeadSha, skipped: write.skipped };
  }
  const headSha = await waitForHeadChange(port, input, timing, signal);
  const commit = await port.getCommit(input.repo, headSha);
  const own = commit.parents.length === 2 && commit.parents[0] === input.expectedHeadSha;
  return { headSha, own, ...(write.done ? {} : { skipped: write.skipped }) };
}

async function waitForHeadChange(port: GitHubPort, input: UpdateInput, timing: Timing, signal: AbortSignal): Promise<string> {
  const clock = deadline(timing);
  for (;;) {
    const pr = await port.getPr(input.repo, input.pr);
    if (pr.headSha !== input.expectedHeadSha) return pr.headSha;
    if (clock.expired()) throw new Error(`update-branch: head still ${input.expectedHeadSha} after ${timing.timeoutMs} ms`);
    await clock.sleep(Math.min(timing.pollMs, 5_000), signal);
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
