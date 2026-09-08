import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { errorResult, modelUsage, successResult } from "./fake-query.js";
import { classifyResult, sumModelCost, usageFromResult } from "./failures.js";

const asResult = (message: unknown) => message as SDKResultMessage;

describe("classifyResult", () => {
  it("returns undefined for a clean success", () => {
    expect(classifyResult(asResult(successResult()))).toBeUndefined();
  });

  it("maps a refusal stop_reason to refusal, not success", () => {
    const result = successResult({ stop_reason: "refusal", result: "I can't help with that" });
    expect(classifyResult(asResult(result))).toMatchObject({ kind: "refusal", reason: "I can't help with that" });
  });

  it.each([
    ["error_max_turns", "max_turns"],
    ["error_max_budget_usd", "budget_exceeded"],
    ["error_max_structured_output_retries", "schema_invalid"],
  ])("maps %s to %s", (subtype, kind) => {
    expect(classifyResult(asResult(errorResult(subtype)))?.kind).toBe(kind);
  });

  it.each([
    "You've hit your session limit; resets 3:45pm",
    "You've hit your weekly limit",
    "request failed: 429 Too Many Requests",
    "rate-limited by the upstream provider",
    "This is a burst limit, not your usage limit",
  ])("reads rate-limit phrasing out of an execution error: %s", (text) => {
    expect(classifyResult(asResult(errorResult("error_during_execution", [text])))?.kind).toBe("rate_limited");
  });

  it("leaves an unrecognised execution error as runtime_error", () => {
    const failure = classifyResult(asResult(errorResult("error_during_execution", ["ENOENT: no such file"])));
    expect(failure).toMatchObject({ kind: "runtime_error", reason: "ENOENT: no such file" });
  });

  it("classifies an API error reported under the success subtype", () => {
    const result = successResult({ is_error: true, result: "429 Too Many Requests" });
    expect(classifyResult(asResult(result))?.kind).toBe("rate_limited");
  });

  it("prefers the stream's rate_limit_event reset time over anything in the prose", () => {
    const resetsAt = Date.UTC(2026, 8, 8, 12, 0, 0);
    const failure = classifyResult(asResult(errorResult("error_during_execution", ["429, retry after 30 seconds"])), {
      now: 0,
      rateLimitResetsAt: resetsAt,
    });
    expect(failure).toMatchObject({ kind: "rate_limited" });
    expect((failure as { retryAt?: Date }).retryAt?.getTime()).toBe(resetsAt);
  });

  it("falls back to a relative retry hint measured from the supplied clock", () => {
    const failure = classifyResult(asResult(errorResult("error_during_execution", ["429: retry after 30 seconds"])), {
      now: 1_000,
    });
    expect((failure as { retryAt?: Date }).retryAt?.getTime()).toBe(31_000);
  });

  it("falls back to an absolute timestamp in the message", () => {
    const errors = ["rate limit hit, resets at 2026-09-08T12:00:00Z"];
    const failure = classifyResult(asResult(errorResult("error_during_execution", errors)));
    expect((failure as { retryAt?: Date }).retryAt?.toISOString()).toBe("2026-09-08T12:00:00.000Z");
  });

  it("leaves retryAt unset when nothing in the message says when", () => {
    const failure = classifyResult(asResult(errorResult("error_during_execution", ["You've hit your weekly limit"])));
    expect(failure).not.toHaveProperty("retryAt");
  });

  it("reports an unknown subtype as a runtime error rather than throwing", () => {
    expect(classifyResult(asResult(errorResult("error_from_a_newer_cli")))).toMatchObject({
      kind: "runtime_error",
      reason: expect.stringContaining("error_from_a_newer_cli"),
    });
  });
});

describe("usageFromResult", () => {
  it("reads the SDK's cumulative cost when it is present", () => {
    const usage = usageFromResult(asResult(successResult({ total_cost_usd: 1.5 })), 900);
    expect(usage).toMatchObject({ totalCostUsd: 1.5, turns: 3, durationMs: 900 });
  });

  it("sums the per-model breakdown when the result arrives with cost zeroed", () => {
    const result = successResult({
      total_cost_usd: 0,
      modelUsage: { "claude-opus-5": modelUsage(0.4), "claude-haiku-4-5": modelUsage(0.1) },
    });
    expect(usageFromResult(asResult(result), 10).totalCostUsd).toBeCloseTo(0.5);
  });

  it("reports zeroes when there is no result at all", () => {
    expect(usageFromResult(undefined, 42)).toEqual({ totalCostUsd: 0, modelUsage: {}, turns: 0, durationMs: 42 });
  });
});

describe("sumModelCost", () => {
  it("adds each model's estimated cost", () => {
    expect(sumModelCost({ a: modelUsage(0.25), b: modelUsage(0.75) })).toBeCloseTo(1);
  });
});
