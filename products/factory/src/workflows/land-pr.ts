import type { GitHubPort, RepoSlug, WriteResult } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow, type StepDeclaration, type WorkflowDefinition } from "../definition.js";
import { gateEverything } from "../gate-policy.js";
import type { StepRoute } from "../routed-runner.js";
import { AWAIT_HEAD_STEPS, AwaitHeadResult, awaitNewHeadRoute } from "./await-head.js";
import { deadline } from "./deadline.js";
import { LAND_STEPS, codeRoute, land, landRoutes, sleep, step, type FailingCheck, type LandDeps, type LandOptions, type LandOutcome } from "./land.js";

/** Conclusions a runner outage or a superseded run produces, which a rerun of the same head can clear. */
const TRANSIENT_CONCLUSIONS = new Set(["cancelled", "timed_out"]);

export const LAND_PR_STEPS: readonly StepDeclaration[] = [
  ...LAND_STEPS,
  ...AWAIT_HEAD_STEPS,
  { id: "snapshot", kind: "dispatch" },
  { id: "rerun", kind: "dispatch" },
  { id: "ci-failed", kind: "assisted" },
];

export interface LandPrParams {
  repo: RepoSlug;
  pr: number;
  task?: string;
}

interface LandPrState {
  round: number;
  reruns: number;
  waits: number;
}

/** Read and check the run's params, so a bad `pr` fails the run before any step records it. */
export function landPrParams(ctx: WorkflowContext): LandPrParams {
  const repo = ctx.param("repo");
  const pr = Number(ctx.param("pr"));
  if (!repo) throw new Error("land-pr: param repo is required");
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`land-pr: param pr must be a positive integer, got ${ctx.param("pr")}`);
  const task = ctx.param("task");
  return { repo, pr, ...(task ? { task } : {}) };
}

/**
 * Land one PR through as many rounds as its CI needs. Code reruns an all-cancelled or timed-out failure once per run;
 * every other red head waits for a human, who may rerun, abandon, or await a fix pushed by someone else.
 */
export async function landPr(ctx: WorkflowContext, params: LandPrParams, options: LandOptions): Promise<LandOutcome> {
  await step(ctx, "snapshot", params, SnapshotResult);
  const state: LandPrState = { round: 0, reruns: 0, waits: 0 };
  for (;;) {
    const outcome = await land(ctx, { repo: params.repo, pr: params.pr, round: state.round }, options);
    if (outcome.kind !== "ci-failed") return outcome;
    const stop = await onCiFailed(ctx, params, outcome, state);
    if (stop) return stop;
    state.round += 1;
  }
}

type RedHead = Extract<LandOutcome, { kind: "ci-failed" }>;

async function onCiFailed(ctx: WorkflowContext, params: LandPrParams, red: RedHead, state: LandPrState): Promise<LandOutcome | undefined> {
  if (state.reruns === 0 && isTransient(red.failing)) return rerun(ctx, params, red, state);
  const decision = await askCiFailed(ctx, params, red);
  if (decision === "abandon") return { kind: "stopped", reason: "abandoned", headSha: red.headSha, detail: "a human abandoned the red head" };
  if (decision === "rerun") return rerun(ctx, params, red, state);
  await step(ctx, `await-new-head:${state.waits++}`, { repo: params.repo, pr: params.pr, headSha: red.headSha }, AwaitHeadResult);
  return undefined;
}

/** Only a failure GitHub Actions can rerun qualifies; a cancelled check from another app would just fail again. */
function isTransient(failing: FailingCheck[]): boolean {
  return failing.length > 0 && failing.every((check) => check.workflowRunId !== null && TRANSIENT_CONCLUSIONS.has(check.conclusion ?? ""));
}

async function rerun(ctx: WorkflowContext, params: LandPrParams, red: RedHead, state: LandPrState): Promise<undefined> {
  await step(ctx, `rerun:${state.reruns++}`, { repo: params.repo, pr: params.pr, headSha: red.headSha, failing: red.failing }, RerunResult);
  return undefined;
}

function ciFailedAnswer(headSha: string) {
  return z.object({ decision: z.enum(["rerun", "abandon", "await-fix"]), headSha: z.literal(headSha) });
}

/** The answer must name the red head shown, so a decision about one head never applies to another. */
async function askCiFailed(ctx: WorkflowContext, params: LandPrParams, red: RedHead): Promise<"rerun" | "abandon" | "await-fix"> {
  const schema = ciFailedAnswer(red.headSha);
  const checks = red.failing.map((check) => `${check.name} (${check.conclusion ?? "no conclusion"}) ${check.url}`).join("; ");
  const prompt = `CI failed on PR #${params.pr} in ${params.repo} at head ${red.headSha}: ${checks || "no failing check named"}. Rerun, abandon, or await a fix?`;
  const answer = schema.safeParse((await ctx.assisted("ci-failed", prompt, { schema })).data);
  if (!answer.success) throw new Error(`ci-failed answer does not name head ${red.headSha}: ${answer.error.message}`);
  return answer.data.decision;
}

const SnapshotResult = z.looseObject({ pr: z.looseObject({ headSha: z.string() }), required: z.array(z.string()) });
const RerunResult = z.looseObject({ reruns: z.array(z.looseObject({ runId: z.number(), done: z.boolean() })) });

export interface LandPrDeps extends LandDeps {
  /** How long a rerun step waits for GitHub to replace the failed checks before land polls CI again. */
  rerunSettleMs?: number;
}

/** Every route `land-pr` dispatches to; each reads before it writes, so each repeats safely after a crash. */
export function landPrRoutes(deps: LandPrDeps): StepRoute[] {
  const now = deps.now ?? Date.now;
  const timing = { now, sleep: deps.sleep ?? sleep, pollMs: deps.pollMs ?? 30_000, timeoutMs: deps.rerunSettleMs ?? 5 * 60_000 };
  return [
    ...landRoutes(deps),
    awaitNewHeadRoute({ port: deps.port, now, sleep: deps.sleep, pollMs: deps.pollMs }),
    codeRoute("snapshot", now, (input: LandPrParams) => snapshot(deps.port, input)),
    codeRoute("rerun", now, (input: RerunInput, signal) => rerunFailed(deps.port, input, timing, signal)),
  ];
}

async function snapshot(port: GitHubPort, input: LandPrParams): Promise<object> {
  const pr = await port.getPr(input.repo, input.pr);
  const required = await port.requiredChecks(input.repo, pr.baseRef);
  const { number, state, merged, draft, headRef, headSha, baseRef } = pr;
  return { pr: { number, state, merged, draft, headRef, headSha, baseRef }, required: required.contexts, strict: required.strict, task: input.task ?? null };
}

interface RerunInput {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  failing: FailingCheck[];
}

interface SettleTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
}

/** One rerun per distinct Actions run, then a bounded wait so the next ci-wait does not read the failed checks again. */
async function rerunFailed(port: GitHubPort, input: RerunInput, timing: SettleTiming, signal: AbortSignal): Promise<object> {
  const runIds = [...new Set(input.failing.flatMap((check) => (check.workflowRunId === null ? [] : [check.workflowRunId])))];
  const reruns: (WriteResult & { runId: number })[] = [];
  for (const runId of runIds) reruns.push({ runId, ...(await port.rerunFailed(input.repo, runId)) });
  return { reruns, settled: await waitSuperseded(port, input, timing, signal) };
}

/** Expiry is not an error: the next ci-wait reads CI afresh, and a still-red head goes to the human gate. */
async function waitSuperseded(port: GitHubPort, input: RerunInput, timing: SettleTiming, signal: AbortSignal): Promise<boolean> {
  const clock = deadline(timing);
  for (;;) {
    if (await superseded(port, input).catch(() => false)) return true;
    if (clock.expired()) return false;
    await clock.sleep(Math.min(timing.pollMs, 5_000), signal);
  }
}

/** True once every failed check has a newer run, or the head moved or the PR closed, so the failure is no longer current. */
async function superseded(port: GitHubPort, input: RerunInput): Promise<boolean> {
  const pr = await port.getPr(input.repo, input.pr);
  if (pr.headSha !== input.headSha || pr.state !== "open") return true;
  const latest = await port.latestCheckRuns(input.repo, input.headSha);
  return input.failing.every((check) => latest.find((run) => run.name === check.name)?.url !== check.url);
}

/** The registered workflow; params `repo`, `pr` and optional `task`. */
export function landPrWorkflow(options: LandOptions = { policy: gateEverything }): WorkflowDefinition {
  return defineWorkflow({ name: "land-pr", steps: LAND_PR_STEPS, run: async (ctx) => void (await landPr(ctx, landPrParams(ctx), options)) });
}
