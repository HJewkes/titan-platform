import os from "node:os";
import { runAgent, type AgentFailure, type AgentRunConfig, type AgentRunResult, type AgentUsage } from "@titan-design/agent";
import { ScoreCardSchema, type ScoreCard } from "./score-card.js";
import type { CallUsage, DigestRunner, ScoreRunner, StepErrorClass } from "./seams.js";

const ERROR_CLASS: Record<AgentFailure["kind"], StepErrorClass> = {
  rate_limited: "other",
  budget_exceeded: "budget",
  schema_invalid: "schema_invalid",
  max_turns: "other",
  refusal: "refusal",
  auth_misconfigured: "other",
  runtime_error: "other",
  aborted: "other",
  inactivity_timeout: "other",
};

type RunBareAgent<T> = (config: AgentRunConfig<T>) => Promise<AgentRunResult<T>>;
export type RunScoreAgent = RunBareAgent<ScoreCard>;

function callUsage(usage: AgentUsage): CallUsage {
  const usages = Object.values(usage.modelUsage);
  const sum = (pick: (u: (typeof usages)[number]) => number) => usages.reduce((n, u) => n + pick(u), 0);
  return {
    costUsd: usage.totalCostUsd,
    inputTokens: sum((u) => u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens),
    outputTokens: sum((u) => u.outputTokens),
  };
}

/** One bare `claude -p` call: no tools, no settings, the CLI's own login as the credential. Without a schema the output is the reply text. */
function bareRunner<T>(run: RunBareAgent<T>, outputSchema?: AgentRunConfig<T>["outputSchema"]): ScoreRunner {
  return async (call) => {
    const result = await run({
      harness: "claude-print",
      model: call.model,
      prompt: call.prompt,
      systemPrompt: call.systemPrompt,
      cwd: os.tmpdir(),
      maxTurns: 2,
      maxBudgetUsd: call.maxBudgetUsd,
      outputSchema,
    });
    if (!result.ok) {
      const { failure } = result;
      return {
        ok: false,
        errorClass: ERROR_CLASS[failure.kind],
        message: failure.reason,
        ...(result.usage ? { usage: callUsage(result.usage) } : {}),
        ...("raw" in failure ? { raw: failure.raw } : {}),
      };
    }
    return {
      ok: true,
      value: { output: result.output, ...callUsage(result.usage), model: Object.keys(result.usage.modelUsage)[0] ?? call.model },
    };
  };
}

export const createClaudeScoreRunner = (run: RunScoreAgent = runAgent): ScoreRunner => bareRunner(run, ScoreCardSchema);
export const claudeScoreRunner: ScoreRunner = createClaudeScoreRunner();
export const claudeDigestRunner: DigestRunner = bareRunner<string>(runAgent);
