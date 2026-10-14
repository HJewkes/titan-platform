import type { GitHubPort } from "@titan-design/github";
import type { RoutedStepInput, StepRoute } from "@titan-design/workflow";
import type { z } from "zod";
import { evidenceRecord } from "../evidence.js";
import { requireBaseRequiredChecks } from "../required-checks.js";
import { redactForEvidence } from "../redact.js";
import { checkBase, mergeOnAllowedBase, waitForRetarget, type BaseCheckInput, type BaseWaitInput } from "./land-base.js";
import type { MergeInput } from "./land-merge-message.js";
import type { CiInput } from "./land-ci.js";
import { afterWrite, waitForCi } from "./land-ci-wait.js";
import type { FirstReads } from "./land-budget.js";
import { flakyState, type FlakyChecks } from "./land-flaky.js";
import { settleRun, type MergeTreeProbe, type SettleInput } from "./land-settle.js";
import { updateBranch, type UpdateInput } from "./land-update.js";
import { portReads, type PrSnapshot } from "./pr-snapshot.js";
import { sleep, stepClock, type StepClock } from "./deadline.js";
import { baseMovedOrThrow, mergePolicyRecord, type LandRulesResult, type MergePolicyInput } from "./land-steps.js";

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


/** Every land step is a code step that reads before it writes, so each is safe to repeat after a crash. */
export function landRoutes(deps: LandDeps): StepRoute[] {
  const now = deps.now ?? Date.now;
  const timing = { now, sleep: deps.sleep ?? sleep, pollMs: deps.pollMs ?? 30_000 };
  const flaky = flakyState(deps.flakyChecks);
  const firstReads: FirstReads = new Map();
  return [
    codeRoute("land-rules", now, (input: { repo: string; pr: number }) => readRules(deps.port, input)),
    codeRoute("ci-wait", now, (input: CiInput, signal, clock) => {
      const ciTiming = { ...timing, timeoutMs: deps.ciTimeoutMs ?? 45 * 60_000, startedAt: clock.firstStartedAtMs };
      return waitForCi(deps, input, ciTiming, signal, flaky, firstReads);
    }),
    codeRoute("update-branch", now, updateRun(deps, timing, now)),
    codeRoute("update-backoff", now, async (input: { waitMs: number; retry: number }, signal) => (await timing.sleep(input.waitMs, signal), input)),
    codeRoute("base-check", now, (input: BaseCheckInput) => checkBase(deps.port, input)),
    codeRoute("base-wait", now, (input: BaseWaitInput, signal) => waitForRetarget(deps.snapshot ?? portReads(deps.port), input, timing, signal)),
    codeRoute("merge", now, async (input: MergeInput) => afterWrite(deps, input, mergeOnAllowedBase(deps.port, input).catch(baseMovedOrThrow))),
    recordRoute("merge-policy", now, async (input: MergePolicyInput, step) => mergePolicyRecord(input, step)),
    codeRoute("merge-settle", now, (input: SettleInput, signal) => settleRun(input, timing, deps.mergeTree, signal)),
  ];
}

function updateRun(deps: LandDeps, timing: Omit<Timing, "timeoutMs">, now: () => number) {
  const updateTiming = { ...timing, timeoutMs: deps.updateTimeoutMs ?? 5 * 60_000 };
  return async (input: UpdateInput, signal: AbortSignal) => ({ ...(await afterWrite(deps, input, updateBranch(deps.port, input, updateTiming, signal))), at: now() });
}

/** `clock` carries the step's first start across a restart, so a wait that reads it resumes its deadline rather than restarting it. */
export function codeRoute<I>(match: string, now: () => number, fn: (input: I, signal: AbortSignal, clock: StepClock) => Promise<object>): StepRoute {
  return recordRoute(match, now, async (input: I, step) => ({ result: await fn(input, step.signal, stepClock(step)) }));
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

async function readRules(port: GitHubPort, input: { repo: string; pr: number }): Promise<z.infer<typeof LandRulesResult>> {
  const pr = await port.getPr(input.repo, input.pr);
  const required = await requireBaseRequiredChecks(port, input.repo, pr.baseRef);
  return { base: pr.baseRef, contexts: required.contexts, strict: required.strict };
}

export interface Timing {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
}
