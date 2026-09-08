import type { ModelUsage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentFailure, AgentUsage } from "./types.js";

/**
 * Rate limiting reaches the caller as prose, not as a subtype, so the phrasing
 * is the only signal. Matching too eagerly would relabel ordinary runtime errors
 * as retryable, so each pattern is anchored on wording the CLI actually emits.
 */
const RATE_LIMIT_PATTERNS = [
  /you'?ve hit your (session|weekly|opus|sonnet) limit/i,
  /not your usage limit/i,
  /\brate[ _-]?limit(ed|ing)?\b/i,
  /\b429\b/,
  /usage limit reached/i,
];

const RETRY_AFTER_SECONDS = /retry(?:ing)?[- ](?:after|in)[ :]*(\d+)\s*(?:s|sec|secs|seconds)?\b/i;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;

export interface ClassifyOptions {
  /** Epoch millis used to turn a relative "retry after Ns" hint into an absolute date. */
  now?: number;
  /** Epoch millis from the stream's last `rate_limit_event`, which beats anything parsed from prose. */
  rateLimitResetsAt?: number;
}

/**
 * Map a terminal `result` message onto the failure taxonomy, or `undefined` when
 * the run succeeded and the caller should read the output.
 */
export function classifyResult(result: SDKResultMessage, options: ClassifyOptions = {}): AgentFailure | undefined {
  const text = errorText(result);

  if (result.subtype === "success") {
    if (result.stop_reason === "refusal") {
      return { kind: "refusal", reason: text || "the model refused the request", raw: result };
    }
    // A success subtype still carries `is_error` when the turn died on an API error.
    return result.is_error ? rateLimitedOrRuntime(text, result, options) : undefined;
  }

  switch (result.subtype) {
    case "error_max_budget_usd":
      return { kind: "budget_exceeded", reason: text || "max budget reached", raw: result };
    case "error_max_turns":
      return { kind: "max_turns", reason: text || "max turns reached", raw: result };
    case "error_max_structured_output_retries":
      return { kind: "schema_invalid", reason: text || "structured-output retries exhausted", raw: result };
    case "error_during_execution":
      return rateLimitedOrRuntime(text, result, options);
    default:
      // Unreachable per the SDK's union, but a newer CLI may add a subtype.
      return { kind: "runtime_error", reason: `unknown result subtype: ${String(result["subtype"])}`, raw: result };
  }
}

function rateLimitedOrRuntime(text: string, raw: SDKResultMessage, options: ClassifyOptions): AgentFailure {
  if (!RATE_LIMIT_PATTERNS.some((p) => p.test(text))) {
    return { kind: "runtime_error", reason: text || "the session ended with an unexplained error", raw };
  }
  const failure: AgentFailure = { kind: "rate_limited", reason: text, raw };
  const retryAt = parseRetryAt(text, options);
  if (retryAt) failure.retryAt = retryAt;
  return failure;
}

function parseRetryAt(text: string, options: ClassifyOptions): Date | undefined {
  if (options.rateLimitResetsAt !== undefined) return new Date(options.rateLimitResetsAt);
  const seconds = RETRY_AFTER_SECONDS.exec(text);
  if (seconds?.[1]) return new Date((options.now ?? Date.now()) + Number(seconds[1]) * 1000);
  const iso = ISO_TIMESTAMP.exec(text);
  if (iso) return new Date(iso[0]);
  return undefined;
}

/** `result` carries the text on a success message, `errors` on every failure subtype. */
function errorText(result: SDKResultMessage): string {
  if (result.subtype === "success") return result.result ?? "";
  return (result.errors ?? []).filter((e) => typeof e === "string" && e.length > 0).join("\n");
}

/**
 * The SDK's cost fields are already cumulative across a `query()` call, so the
 * latest result carries the running total and summing them would double-count.
 * `modelUsage` is the fallback because a crash result can arrive with
 * `total_cost_usd` zeroed while the per-model breakdown survives.
 */
export function usageFromResult(result: SDKResultMessage | undefined, durationMs: number): AgentUsage {
  const modelUsage = result?.modelUsage ?? {};
  const reported = result?.total_cost_usd;
  const totalCostUsd = typeof reported === "number" && reported > 0 ? reported : sumModelCost(modelUsage);
  return { totalCostUsd, modelUsage, turns: result?.num_turns ?? 0, durationMs };
}

export function sumModelCost(modelUsage: Record<string, ModelUsage>): number {
  return Object.values(modelUsage).reduce((total, m) => total + (m.costUSD ?? 0), 0);
}
