import type { UsageMeasurement } from "@titan-design/agent-protocol";
import type { HarnessRunFailure } from "./harness-contracts.js";
import type { AgentFailure, AgentUsage } from "./types.js";

export function claudeFailure(failure: AgentFailure): HarnessRunFailure {
  const reason = failure.reason;
  switch (failure.kind) {
    case "rate_limited": return { kind: "rate_limited", reason, retryAtMs: failure.retryAt?.getTime() };
    case "budget_exceeded": return { kind: "limit_exceeded", reason, unit: "usd" };
    case "max_turns": return { kind: "runtime_error", reason: `native maxTurns reached: ${reason}` };
    case "schema_invalid": return { kind: "output_invalid", reason };
    case "inactivity_timeout": return { kind: "cancelled_unknown", reason };
    case "refusal": return { kind: "output_invalid", reason: `native refusal: ${reason}` };
    case "auth_misconfigured": return { kind: "auth_misconfigured", reason };
    case "aborted": return { kind: "aborted", reason };
    case "runtime_error": return { kind: "runtime_error", reason };
  }
}

export function claudeUsage(usage: AgentUsage | undefined, executionId: string): UsageMeasurement[] {
  if (!usage) return [];
  const models = Object.entries(usage.modelUsage);
  type Counts = AgentUsage["modelUsage"][string];
  const sum = (field: keyof Counts): number | null => {
    const values = models.map(([, model]) => model[field]);
    if (values.length === 0) return null;
    let total = 0;
    for (const value of values) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      total += value;
    }
    return total;
  };
  const uncached = sum("inputTokens");
  const cachedInput = sum("cacheReadInputTokens");
  const cacheWriteInput = sum("cacheCreationInputTokens");
  const input = uncached === null || cachedInput === null || cacheWriteInput === null
    ? null : uncached + cachedInput + cacheWriteInput;
  // A snapshot identity denotes the entire query; per-model snapshots would replace each other.
  return [{
    kind: "snapshot", scope: "turn", scopeId: executionId, epoch: executionId, sequence: 0,
    model: models.length === 1 ? models[0]![0] : null, source: "claude-sdk:query-result",
    tokens: { input, output: sum("outputTokens"), cachedInput, cacheWriteInput, reasoningOutput: null, total: null },
    cost: { usd: usage.totalCostUsd, kind: "estimate" },
  }];
}
