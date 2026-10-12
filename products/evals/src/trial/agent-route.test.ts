import type { AgentRunConfig, AgentRunDeps, AgentRunResult } from "@titan-design/agent";
import { describe, expect, it, vi } from "vitest";
import { agentRoute, type AgentLaunch } from "./agent-route.js";
import type { LaunchRequest } from "./routes.js";

const MODEL = "claude-sonnet-5-5";
const request: LaunchRequest = {
  stepId: "summarize",
  harness: "claude-code",
  prompt: "Summarize the note",
  model: MODEL,
  maxTurns: 4,
  maxBudgetUsd: 0.5,
  allowedTools: ["Read"],
  signal: new AbortController().signal,
  onMessage: () => undefined,
};

function fakeLaunch() {
  return vi.fn<AgentLaunch>(async (_config: AgentRunConfig<unknown>, _deps: AgentRunDeps): Promise<AgentRunResult<unknown>> => ({ ok: false, failure: { kind: "runtime_error", reason: "fake" } }));
}

describe("agentRoute", () => {
  it("launch gets the trial workspace as cwd and CLAUDE_CONFIG_DIR as the trial config dir", async () => {
    const launch = fakeLaunch();
    const env = { HOME: "/operator", CLAUDE_CONFIG_DIR: "/operator/.claude" };
    const trials = [
      { workspace: "/runs/r1/t1/workspace", configDir: "/runs/r1/t1/config" },
      { workspace: "/runs/r1/t2/workspace", configDir: "/runs/r1/t2/config" },
    ];

    for (const sandbox of trials) await agentRoute(sandbox, { launch, env })(request);

    expect(launch.mock.calls.map(([config, deps]) => [config.cwd, deps.env?.CLAUDE_CONFIG_DIR])).toEqual(trials.map((trial) => [trial.workspace, trial.configDir]));
    expect(launch.mock.calls[0]?.[1].env?.HOME).toBe("/operator");
  });

  it("passes the step's model, budgets, tools, signal and message observer through to the launch", async () => {
    const launch = fakeLaunch();

    await agentRoute({ workspace: "/w", configDir: "/c" }, { launch, env: {} })(request);

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "claude-code", prompt: "Summarize the note", model: MODEL, maxTurns: 4, maxBudgetUsd: 0.5, allowedTools: ["Read"], signal: request.signal, onMessage: request.onMessage }),
      expect.anything(),
    );
  });
});
