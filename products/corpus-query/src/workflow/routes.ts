import { tmpdir } from "node:os";
import { agentRunner, routedRunner, type AgentRunnerOptions, type LegacyStepRunner, type RoutedRunner } from "@titan-design/workflow";

export interface Models {
  compile: string;
  screen: string;
  confirm: string;
  /** Judges a batch its stage's own model failed twice; a stronger model than screen, so a safety stop is not final. */
  redo: string;
}

export const DEFAULT_MODELS: Models = { compile: "sonnet", screen: "haiku", confirm: "sonnet", redo: "sonnet" };

/** Per-call spend ceilings for the CLI; the run's own budget is enforced across calls by `mapItems`. */
const CALL_BUDGET_USD = { compile: 0.5, screen: 0.5, confirm: 2 } as const;

export type RunnerFor = (options: AgentRunnerOptions) => LegacyStepRunner;

export interface RouteConfig {
  stage: keyof typeof CALL_BUDGET_USD;
  model: string;
  /** The cached prefix: every call of the stage sends these bytes as its system prompt. */
  systemPrompt: string;
}

/**
 * Every judge call sends a batch no other call repeats, and the shared prefix is too small to pay for itself, so a
 * cache write (billed at twice the input rate for the CLI's 1h TTL) would never be read back. Measured on a 20-batch
 * haiku screen wave, turning it off cut the cost per call by 17%.
 */
const NO_PROMPT_CACHE = { DISABLE_PROMPT_CACHING: "1" } as const;

/**
 * One tool-less `claude -p` call per step. The harness runs bare (no tools, MCP, settings or skills), so the
 * system prompt is the child's whole world and stays small.
 */
function stageRunner(config: RouteConfig, runnerFor: RunnerFor): LegacyStepRunner {
  return runnerFor({
    cwd: tmpdir(),
    maxTurns: 1,
    maxBudgetUsd: CALL_BUDGET_USD[config.stage],
    defaults: { harness: "claude-print", model: config.model, systemPrompt: config.systemPrompt },
    deps: { env: { ...process.env, ...NO_PROMPT_CACHE } },
  });
}

/** Routes each stage's steps, `<stage>:…`, to its own runner. Judgements are read-only, so a restart repeats them. */
export function stageRoutes(configs: readonly RouteConfig[], runnerFor: RunnerFor = agentRunner): RoutedRunner {
  return routedRunner(configs.map((config) => ({ match: config.stage, runner: stageRunner(config, runnerFor), onRestart: "repeat" })));
}
