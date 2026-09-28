import { runAgent, type AgentRunConfig, type AgentRunDeps, type AgentUsage } from "@titan-design/agent";
import type { DurableStepOutcome, LegacyStepRunner, RecoverableStepRunner, StepRunInput, StepRunOutcome, StepUsage } from "./types.js";

/** Failure kinds where a fresh attempt could plausibly succeed. Budget, auth, and refusal would only repeat. */
const RETRYABLE = new Set(["rate_limited", "runtime_error", "inactivity_timeout"]);

export interface AgentRunnerOptions {
  cwd: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Everything else `runAgent` accepts, applied to every step; the step's own `model` wins. */
  defaults?: Partial<Omit<AgentRunConfig<unknown>, "prompt" | "cwd" | "maxTurns" | "maxBudgetUsd" | "signal">>;
  deps?: AgentRunDeps;
}

/**
 * Run each step as one headless Claude Code session through
 * `@titan-design/agent`. In-process, so a restart cannot re-attach; hydrate
 * marks interrupted steps recovery_required without redispatching them.
 */
export function agentRunner(options: AgentRunnerOptions): LegacyStepRunner {
  return {
    async run(input: StepRunInput): Promise<StepRunOutcome> {
      const result = await runAgent(
        { ...options.defaults, prompt: input.prompt, cwd: options.cwd, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, model: input.model ?? options.defaults?.model, signal: input.signal },
        options.deps,
      );
      if (result.ok) return { ok: true, output: outputText(result.output), runnerRef: result.sessionId, usage: stepUsage(result.usage) };
      const failed: StepRunOutcome = { ok: false, error: `${result.failure.kind}: ${result.failure.reason}`, retryable: RETRYABLE.has(result.failure.kind) };
      return result.usage ? { ...failed, usage: stepUsage(result.usage) } : failed;
    },
  };
}

/** An `outputSchema` run returns an object; steps store text, so it is kept as JSON. */
function outputText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function stepUsage(usage: AgentUsage): StepUsage {
  const models = Object.values(usage.modelUsage);
  return {
    costUsd: usage.totalCostUsd,
    inputTokens: models.reduce((sum, model) => sum + model.inputTokens, 0),
    outputTokens: models.reduce((sum, model) => sum + model.outputTokens, 0),
  };
}

/**
 * Make a live runner recoverable for steps that are safe to repeat, such as
 * read-only judgements. After a restart, an interrupted step is dispatched
 * again instead of parking the run as recovery_required. The step's
 * `agentId` becomes the request key, because the ack must name it before the
 * live runner has reported its own reference.
 */
export function idempotentRunner(live: LegacyStepRunner): RecoverableStepRunner {
  return {
    async dispatch(input) {
      const completion = live.run(input).then(toDurableOutcome, (error: unknown) => failedOutcome(error));
      return { executionId: input.executionId, requestKey: input.requestKey, runnerRef: input.requestKey, completion };
    },
    async reconcile() {
      return { kind: "not_found", retrySafe: true, evidence: "in-process step did not survive the restart and is safe to repeat" };
    },
  };
}

function toDurableOutcome(outcome: StepRunOutcome): DurableStepOutcome {
  if (outcome.ok) return { kind: "succeeded", output: outcome.output, usage: outcome.usage };
  return { kind: "failed", error: outcome.error, retryable: outcome.retryable, usage: outcome.usage };
}

function failedOutcome(error: unknown): DurableStepOutcome {
  return { kind: "failed", error: error instanceof Error ? error.message : String(error), retryable: false };
}

/** Run steps with a plain function. For tests and for workflows whose steps are not agents. */
export function inlineRunner(fn: (input: StepRunInput) => Promise<string> | string): LegacyStepRunner {
  return {
    async run(input) {
      try {
        return { ok: true, output: await fn(input) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: false };
      }
    },
  };
}
