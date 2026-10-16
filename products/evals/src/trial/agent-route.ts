import { runAgent, type AgentRunConfig, type AgentRunDeps, type AgentRunResult } from "@titan-design/agent";
import type { LaunchRequest, TrialLaunch } from "./routes.js";

/** The one place a model is launched; TP-2299 replaces the `runAgent` default with the sealed launch. */
export type AgentLaunch = (config: AgentRunConfig<unknown>, deps: AgentRunDeps) => Promise<AgentRunResult<unknown>>;

/** A trial's own scratch: the agent works in `workspace` and reads Claude settings only from `configDir`. */
export interface TrialSandbox {
  workspace: string;
  configDir: string;
}

export interface AgentRouteOptions {
  launch?: AgentLaunch;
  /** The environment the launch scrubs; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Binds a trial's launch port to its sandbox, so no trial shares a cwd or inherits the operator's Claude config. */
export function agentRoute(sandbox: TrialSandbox, options: AgentRouteOptions = {}): TrialLaunch {
  const launch = options.launch ?? runAgent;
  const env = { ...(options.env ?? process.env), CLAUDE_CONFIG_DIR: sandbox.configDir };
  return (request) => launch(agentConfig(request, sandbox.workspace), { env });
}

function agentConfig(request: LaunchRequest, cwd: string): AgentRunConfig<unknown> {
  const { harness, prompt, model, maxTurns, maxBudgetUsd, tools, allowedTools, disallowedTools, signal, onMessage } = request;
  return { harness, prompt, cwd, model, maxTurns, maxBudgetUsd, tools, allowedTools, disallowedTools, signal, onMessage };
}
