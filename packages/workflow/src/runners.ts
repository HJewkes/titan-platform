import { runAgent, type AgentRunConfig, type AgentRunDeps } from "@titan-design/agent";
import type { StepRunInput, StepRunOutcome, StepRunner } from "./types.js";

/** Failure kinds where a fresh attempt could plausibly succeed. Budget, auth, and refusal would only repeat. */
const RETRYABLE = new Set(["rate_limited", "runtime_error", "inactivity_timeout"]);

export interface AgentRunnerOptions {
  cwd: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Everything else `runAgent` accepts, applied to every step; the step's own `model` wins. */
  defaults?: Partial<Omit<AgentRunConfig, "prompt" | "cwd" | "maxTurns" | "maxBudgetUsd" | "signal">>;
  deps?: AgentRunDeps;
}

/**
 * Run each step as one headless Claude Code session through
 * `@titan-design/agent`. In-process, so a restart cannot re-attach: an
 * interrupted step is re-dispatched from the workflow's replay.
 */
export function agentRunner(options: AgentRunnerOptions): StepRunner {
  return {
    async run(input: StepRunInput): Promise<StepRunOutcome> {
      const result = await runAgent(
        { ...options.defaults, prompt: input.prompt, cwd: options.cwd, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, model: input.model ?? options.defaults?.model, signal: input.signal },
        options.deps,
      );
      if (result.ok) return { ok: true, output: String(result.output), runnerRef: result.sessionId };
      return { ok: false, error: `${result.failure.kind}: ${result.failure.reason}`, retryable: RETRYABLE.has(result.failure.kind) };
    },
  };
}

/** Run steps with a plain function. For tests and for workflows whose steps are not agents. */
export function inlineRunner(fn: (input: StepRunInput) => Promise<string> | string): StepRunner {
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
