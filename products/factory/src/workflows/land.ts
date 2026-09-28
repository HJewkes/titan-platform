import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { evidenceRecord } from "../evidence.js";
import type { GatePolicy } from "../gate-policy.js";
import { evaluateChecks } from "../github/checks.js";
import type { GitHubPort, MergeMethod, PullRequest, RepoSlug } from "../github/port.js";
import { redactForEvidence } from "../redact.js";
import type { RoutedStepInput, StepRoute } from "../routed-runner.js";

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
}

export interface LandOptions {
  /** Consulted before the merge gate. Only `deny` changes anything: there is no allow path until F5 is approved. */
  policy: GatePolicy;
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

interface MergeResult {
  done: boolean;
  skipped?: string;
  mergeSha: string;
}

interface LandState {
  cycle: number;
  updates: number;
  updatesSinceGate: number;
  merges: number;
  /** Heads a resolved approve-merge gate covers: the approved head plus heads this run's updates built on it. */
  trusted: Set<string>;
}

/**
 * Wait for green, keep the branch current, and merge the exact head a human approved. Returns
 * instead of merging on anything else, so the calling pilot decides what a red CI means.
 */
export async function land(ctx: WorkflowContext, input: LandInput, options: LandOptions): Promise<LandOutcome> {
  const rules = await step<LandRules>(ctx, "land-rules", { repo: input.repo, pr: input.pr });
  const state: LandState = { cycle: 0, updates: 0, updatesSinceGate: 0, merges: 0, trusted: new Set() };
  for (;;) {
    if (state.cycle >= MAX_CI_CYCLES) throw new Error(`land: PR #${input.pr} did not settle within ${MAX_CI_CYCLES} ci-wait cycles`);
    const ci = await step<CiSnapshot>(ctx, `ci-wait:${state.cycle++}`, { repo: input.repo, pr: input.pr, contexts: rules.contexts, strict: rules.strict });
    const next = ci.verdict === "behind" ? await onBehind(ctx, input, ci, state) : await onSettled(ctx, input, ci, state, options);
    if (next) return next;
  }
}

async function onBehind(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState): Promise<LandOutcome | undefined> {
  if (state.updatesSinceGate >= MAX_UPDATE_CYCLES) {
    const answer = await ctx.assisted("stuck-behind", `PR #${input.pr} in ${input.repo} is still behind its base after ${MAX_UPDATE_CYCLES} updates. Retry or abandon?`, { schema: StuckBehindAnswer });
    if (StuckBehindAnswer.parse(answer.data).decision === "abandon") return stopped("stuck-behind", ci.headSha, `behind after ${state.updates} updates`);
    state.updatesSinceGate = 0;
  }
  const update = await step<UpdateResult>(ctx, `update-branch:${state.updates++}`, { repo: input.repo, pr: input.pr, expectedHeadSha: ci.headSha });
  state.updatesSinceGate += 1;
  if (update.own && state.trusted.has(ci.headSha)) state.trusted.add(update.headSha);
  return undefined;
}

async function onSettled(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, options: LandOptions): Promise<LandOutcome | undefined> {
  if (ci.verdict === "red") return { kind: "ci-failed", headSha: ci.headSha, failing: ci.failing ?? [] };
  if (ci.verdict === "merged") return { kind: "merged", headSha: ci.headSha, mergeSha: ci.mergeSha ?? "" };
  if (ci.verdict === "closed") return stopped("closed", ci.headSha, "the pull request was closed without merging");
  if (ci.verdict !== "green") return stopped("not-mergeable", ci.headSha, `mergeable_state is ${ci.mergeableState}`);
  if (!state.trusted.has(ci.headSha)) return approve(ctx, input, ci, state, options.policy);
  const merge = await step<MergeResult>(ctx, `merge:${state.merges++}`, { repo: input.repo, pr: input.pr, sha: ci.headSha, method: input.method ?? "squash" });
  if (merge.done || merge.skipped === "merged") return { kind: "merged", headSha: ci.headSha, mergeSha: merge.mergeSha };
  if (merge.skipped === "closed") return stopped("closed", ci.headSha, "the pull request was closed before the merge");
  return undefined;
}

function approveMergeAnswer(headSha: string) {
  return z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.literal(headSha) });
}

const StuckBehindAnswer = z.object({ decision: z.enum(["retry", "abandon"]) });

/** The payload must name the head shown, so an approval can never carry over to a head the human did not see. */
async function approve(ctx: WorkflowContext, input: LandInput, ci: CiSnapshot, state: LandState, policy: GatePolicy): Promise<LandOutcome | undefined> {
  const decision = policy.decide("merge");
  if (decision.outcome === "deny") return stopped("merge-denied", ci.headSha, decision.reason);
  const schema = approveMergeAnswer(ci.headSha);
  const prompt = `Merge PR #${input.pr} in ${input.repo} at head ${ci.headSha}? CI is green. Policy ${decision.rule.table}/${decision.rule.rowId}: ${decision.reason}`;
  const answer = schema.safeParse((await ctx.assisted("approve-merge", prompt, { schema })).data);
  if (!answer.success) throw new Error(`approve-merge answer does not approve head ${ci.headSha}: ${answer.error.message}`);
  if (answer.data.decision === "abandon") return stopped("abandoned", ci.headSha, "a human declined the merge");
  state.trusted = new Set([ci.headSha]);
  state.updatesSinceGate = 0;
  return undefined;
}

function stopped(reason: Extract<LandOutcome, { kind: "stopped" }>["reason"], headSha: string, detail: string): LandOutcome {
  return { kind: "stopped", reason, headSha, detail };
}

/** Code steps take their input as JSON and answer with one evidence record whose `result` the workflow reads. */
async function step<T>(ctx: WorkflowContext, stepId: string, input: object): Promise<T> {
  const done = await ctx.dispatch(stepId, TEMPLATE, { vars: { [INPUT_VAR]: JSON.stringify(input) } });
  return (JSON.parse(done.output ?? "{}") as { result: T }).result;
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
  ];
}

function codeRoute<I>(match: string, now: () => number, fn: (input: I, signal: AbortSignal) => Promise<object>): StepRoute {
  const run = async (step: RoutedStepInput) => {
    try {
      const result = await fn(JSON.parse(step.prompt) as I, step.signal);
      const record = evidenceRecord(`land.${match}`, step, new Date(now()).toISOString(), { result });
      return { ok: true as const, output: JSON.stringify(record) };
    } catch (error) {
      return { ok: false as const, error: redactForEvidence(error instanceof Error ? error.message : String(error)), retryable: false };
    }
  };
  return { match, onRestart: "repeat", runner: { run } };
}

async function readRules(port: GitHubPort, input: { repo: string; pr: number }): Promise<LandRules> {
  const pr = await port.getPr(input.repo, input.pr);
  const required = await port.requiredChecks(input.repo, pr.baseRef);
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
  const deadline = timing.now() + timing.timeoutMs;
  let last = "no read yet";
  for (;;) {
    try {
      const snapshot = await readCi(port, input);
      if (snapshot.verdict !== "pending") return snapshot;
      last = `waiting on ${snapshot.waitingOn?.join(", ") || `mergeable_state ${snapshot.mergeableState}`}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (timing.now() >= deadline) throw new Error(`ci-wait timed out after ${timing.timeoutMs} ms: ${last}`);
    await timing.sleep(timing.pollMs, signal);
  }
}

export async function readCi(port: GitHubPort, input: CiInput): Promise<CiSnapshot> {
  const pr = await port.getPr(input.repo, input.pr);
  const base = { headSha: pr.headSha, mergeableState: pr.mergeableState };
  if (pr.merged) return { ...base, verdict: "merged", mergeSha: pr.mergeSha };
  if (pr.state === "closed") return { ...base, verdict: "closed" };
  if ((input.strict && pr.behind) || pr.mergeableState === "behind") return { ...base, verdict: "behind" };
  const checks = evaluateChecks(input.contexts, await port.latestCheckRuns(input.repo, pr.headSha));
  if (checks.state === "failed") {
    const failing = checks.failing.map((run) => ({ name: run.name, conclusion: run.conclusion, url: run.url, workflowRunId: run.workflowRunId }));
    return { ...base, verdict: "red", failing };
  }
  if (checks.state === "pending") return { ...base, verdict: "pending", waitingOn: checks.pending };
  return { ...base, verdict: mergeVerdict(pr) };
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
  const deadline = timing.now() + timing.timeoutMs;
  for (;;) {
    const pr = await port.getPr(input.repo, input.pr);
    if (pr.headSha !== input.expectedHeadSha) return pr.headSha;
    if (timing.now() >= deadline) throw new Error(`update-branch: head still ${input.expectedHeadSha} after ${timing.timeoutMs} ms`);
    await timing.sleep(Math.min(timing.pollMs, 5_000), signal);
  }
}

interface MergeInput {
  repo: string;
  pr: number;
  sha: string;
  method: MergeMethod;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => (signal.removeEventListener("abort", abort), resolve()), ms);
    const abort = () => (clearTimeout(timer), reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
  });
}
