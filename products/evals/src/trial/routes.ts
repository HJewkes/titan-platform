import type { AgentRunHarness, AgentRunResult } from "@titan-design/agent";
import { inlineRunner, type RestartRule, type RouteRunner, type RoutedStepInput, type StepRoute, type StepRunInput, type StepRunOutcome } from "@titan-design/workflow";
import type { StepSpec, VariantSpec } from "../spec/index.js";
import { addCost, callObserver, costOf, type TrialAttempt, type TrialObservations } from "./record.js";

/** An in-process implementation of a variant's `code` step, named by the topology. */
export type CodeStep = (input: StepRunInput) => Promise<string> | string;

/** What a model step asks the launch port for; the port owns the cwd, the config dir and the seal. */
export interface LaunchRequest {
  stepId: string;
  harness: AgentRunHarness;
  prompt: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  signal: AbortSignal;
  onMessage: (message: unknown) => void;
}

export type TrialLaunch = (request: LaunchRequest) => Promise<AgentRunResult<unknown>>;

export interface ManifestRouteDeps {
  code: Readonly<Record<string, CodeStep>>;
  launch?: TrialLaunch;
  observations: TrialObservations;
  now: () => number;
}

type LaunchShape = Omit<LaunchRequest, "stepId" | "prompt" | "signal" | "onMessage">;
type AttemptRunner = (input: RoutedStepInput, attempt: TrialAttempt) => Promise<StepRunOutcome>;

/** One route per variant step, so the manifest and not the topology decides where each step runs. */
export function manifestRoutes(variant: VariantSpec, deps: ManifestRouteDeps): StepRoute[] {
  return Object.entries(variant.steps).map(([stepId, step]) => ({
    match: stepId,
    onRestart: restartRule(step),
    runner: recorded(stepId, attemptRunner(variant.id, stepId, step, deps), deps),
  }));
}

/** An llm step is one model turn with no tools, so repeating it after a crash has no side effect to duplicate. */
function restartRule(step: StepSpec): RestartRule {
  return "onRestart" in step ? step.onRestart : "repeat";
}

function attemptRunner(variantId: string, stepId: string, step: StepSpec, deps: ManifestRouteDeps): AttemptRunner {
  const where = `variant ${variantId}: step "${stepId}"`;
  switch (step.kind) {
    case "code": {
      const impl = deps.code[stepId];
      if (!impl) throw new Error(`${where} is a code step and the topology has no implementation for it`);
      return (input) => inlineRunner(impl).run(input);
    }
    case "agent":
      if (step.runner.via !== "agent" || step.runner.harness !== "claude-code") throw new Error(`${where} runs via ${describeRunner(step.runner)}; E3 trials launch only claude-code agents`);
      return launchRunner(where, stepId, agentShape(step), deps);
    case "llm":
      return launchRunner(where, stepId, { harness: "claude-print", model: step.model, maxTurns: 1, maxBudgetUsd: step.maxBudgetUsd, tools: [] }, deps);
    case "gate":
    case "unit":
      throw new Error(`${where} is a ${step.kind} step; E3 trials route only code, agent and llm steps`);
  }
}

function describeRunner(runner: Extract<StepSpec, { kind: "agent" }>["runner"]): string {
  return runner.via === "agent" ? `agent harness ${runner.harness}` : `agent-dispatch profile ${runner.profile}`;
}

function agentShape(step: Extract<StepSpec, { kind: "agent" }>): LaunchShape {
  const { model, maxTurns, maxBudgetUsd, tools, allowedTools, disallowedTools } = step;
  return { harness: "claude-code", model, maxTurns, maxBudgetUsd, tools, allowedTools, disallowedTools };
}

function launchRunner(where: string, stepId: string, shape: LaunchShape, deps: ManifestRouteDeps): AttemptRunner {
  const { launch } = deps;
  if (!launch) throw new Error(`${where} launches a model and the trial host has no launch port`);
  return async (input, attempt) => {
    const result = await launch({ ...shape, stepId, prompt: input.prompt, signal: input.signal, onMessage: callObserver(stepId, deps.observations.calls) });
    if (result.usage) {
      attempt.usage = costOf(result.usage);
      addCost(deps.observations.cost, attempt.usage);
    }
    if (!result.ok) return failed(attempt, result.failure.kind, `${result.failure.kind}: ${result.failure.reason}`);
    deps.observations.model = result.init.model;
    if (result.init.model !== shape.model) return failed(attempt, "model_mismatch", `model_mismatch: ${where} asked for ${shape.model}, the session ran ${result.init.model ?? "an unreported model"}`);
    const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    return { ok: true, output, runnerRef: result.sessionId, usage: { costUsd: result.usage.totalCostUsd } };
  };
}

/** Never retryable: the runtime would re-dispatch inside the trial, and an infra trial is re-run whole instead. */
function failed(attempt: TrialAttempt, failure: NonNullable<TrialAttempt["failure"]>, error: string): StepRunOutcome {
  attempt.failure = failure;
  return { ok: false, error, retryable: false, usage: attempt.usage && { costUsd: attempt.usage.usd } };
}

function recorded(stepId: string, run: AttemptRunner, deps: ManifestRouteDeps): RouteRunner {
  return {
    async run(input) {
      const attempt: TrialAttempt = { stepId, attempt: input.attempt, startedAt: new Date(deps.now()).toISOString() };
      deps.observations.attempts.push(attempt);
      attempt.ok = false;
      try {
        const outcome = await run(input, attempt);
        attempt.ok = outcome.ok;
        if (!outcome.ok) attempt.error = outcome.error;
        return outcome;
      } finally {
        attempt.endedAt = new Date(deps.now()).toISOString();
      }
    },
  };
}
