import type { AgentFailureKind, AgentUsage } from "@titan-design/agent";
import type { WorkflowRun } from "@titan-design/workflow";
import type { TrialRecord } from "../spec/index.js";

/** `passed-run` means the variant ran to the end; whether its output is any good is the checks' call, not the host's. */
export type TrialOutcome = "passed-run" | "failed" | "infra";

/** The account or the runtime failed, not the variant, so the trial says nothing about the variant (design 1.6). */
const INFRA_FAILURES: ReadonlySet<string> = new Set<AgentFailureKind>(["rate_limited", "auth_misconfigured", "runtime_error"]);

export interface TrialCost {
  usd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
}

/** One dispatch of one step. */
export interface TrialAttempt {
  stepId: string;
  attempt: number;
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  /** An agent failure kind, or `model_mismatch` when the session ran a model other than the step's. */
  failure?: AgentFailureKind | "model_mismatch";
  error?: string;
  usage?: TrialCost;
}

export interface TrialCall {
  stepId: string;
  tool: string;
  isError: boolean;
}

/** What one trial did at run time; its identity is the hashed spec, everything else is observation. */
export interface TrialRunRecord {
  trialId: string;
  identity: TrialRecord;
  attempts: TrialAttempt[];
  calls: TrialCall[];
  cost: TrialCost;
  model?: string;
  outcome: TrialOutcome;
  output?: string;
  error?: string;
}

export type TrialObservations = Pick<TrialRunRecord, "attempts" | "calls" | "cost" | "model">;

export function emptyCost(): TrialCost {
  return { usd: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0 };
}

export function costOf(usage: AgentUsage): TrialCost {
  const models = Object.values(usage.modelUsage);
  const sum = (pick: (model: (typeof models)[number]) => number) => models.reduce((total, model) => total + pick(model), 0);
  return {
    usd: usage.totalCostUsd,
    tokensIn: sum((model) => model.inputTokens),
    tokensOut: sum((model) => model.outputTokens),
    tokensCacheRead: sum((model) => model.cacheReadInputTokens),
  };
}

export function addCost(total: TrialCost, more: TrialCost): void {
  total.usd += more.usd;
  total.tokensIn += more.tokensIn;
  total.tokensOut += more.tokensOut;
  total.tokensCacheRead += more.tokensCacheRead;
}

type Block = Record<string, unknown>;

function blocksOf(message: unknown, type: "assistant" | "user"): Block[] {
  if (typeof message !== "object" || message === null) return [];
  const { type: messageType, message: inner } = message as { type?: unknown; message?: { content?: unknown } };
  if (messageType !== type || !Array.isArray(inner?.content)) return [];
  return inner.content.filter((block): block is Block => typeof block === "object" && block !== null);
}

/** Records a call per `tool_use` block and marks it errored when its `tool_result` comes back with `is_error`. */
export function callObserver(stepId: string, calls: TrialCall[]): (message: unknown) => void {
  const byUseId = new Map<string, TrialCall>();
  return (message) => {
    for (const block of blocksOf(message, "assistant")) {
      if (block.type !== "tool_use") continue;
      const call: TrialCall = { stepId, tool: String(block.name), isError: false };
      calls.push(call);
      if (typeof block.id === "string") byUseId.set(block.id, call);
    }
    for (const block of blocksOf(message, "user")) {
      if (block.type !== "tool_result" || block.is_error !== true || typeof block.tool_use_id !== "string") continue;
      const call = byUseId.get(block.tool_use_id);
      if (call) call.isError = true;
    }
  };
}

export function outcomeOf(status: WorkflowRun["status"], attempts: readonly TrialAttempt[]): TrialOutcome {
  if (status === "completed") return "passed-run";
  return attempts.some((attempt) => attempt.failure !== undefined && INFRA_FAILURES.has(attempt.failure)) ? "infra" : "failed";
}

/** The output of the step that finished last, which is the variant's answer for a single-path topology. */
export function finalOutput(run: WorkflowRun): string | undefined {
  const results = Object.values(run.stepResults).filter((result) => result.output !== undefined);
  return results.sort((a, b) => a.completedAt.localeCompare(b.completedAt)).at(-1)?.output;
}
