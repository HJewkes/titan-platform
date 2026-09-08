import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  SESSION_ID,
  assistantMessage,
  errorResult,
  fakeQuery,
  initMessage,
  modelUsage,
  rateLimitEvent,
  successResult,
} from "./fake-query.js";
import { DEFAULT_INACTIVITY_MS, runAgent, type AgentRunDeps } from "./run.js";
import type { AgentRunConfig } from "./types.js";

const OAUTH_ENV: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth", PATH: "/usr/bin" };

function config<T>(overrides: Partial<AgentRunConfig<T>> = {}): AgentRunConfig<T> {
  return { prompt: "do the thing", cwd: "/tmp/work", maxTurns: 5, maxBudgetUsd: 1, ...overrides } as AgentRunConfig<T>;
}

function deps(query: AgentRunDeps["query"]): AgentRunDeps {
  return { query, env: OAUTH_ENV };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runAgent budgets", () => {
  it.each([
    ["maxTurns", { maxTurns: undefined }],
    ["maxTurns", { maxTurns: 0 }],
    ["maxTurns", { maxTurns: -1 }],
    ["maxBudgetUsd", { maxBudgetUsd: undefined }],
    ["maxBudgetUsd", { maxBudgetUsd: 0 }],
    ["maxBudgetUsd", { maxBudgetUsd: Number.NaN }],
  ])("throws before calling query when %s is missing or non-positive", async (field, overrides) => {
    const fake = fakeQuery([]);
    await expect(runAgent(config(overrides), deps(fake.run))).rejects.toThrow(new RegExp(field));
    expect(fake.lastOptions).toBeUndefined();
  });

  it("passes both circuit breakers through to the SDK", async () => {
    const fake = fakeQuery([initMessage(), successResult()]);
    await runAgent(config({ maxTurns: 9, maxBudgetUsd: 2.5 }), deps(fake.run));
    expect(fake.lastOptions).toMatchObject({ maxTurns: 9, maxBudgetUsd: 2.5 });
  });
});

describe("runAgent options", () => {
  it("defaults to dontAsk and reads nothing off the filesystem", async () => {
    const fake = fakeQuery([initMessage(), successResult()]);
    await runAgent(config(), deps(fake.run));
    expect(fake.lastOptions).toMatchObject({ permissionMode: "dontAsk", settingSources: [] });
  });

  it("hands the SDK a scrubbed environment, not the caller's", async () => {
    const fake = fakeQuery([initMessage(), successResult()]);
    await runAgent(config(), { query: fake.run, env: { ...OAUTH_ENV, CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-ant" } });
    const env = fake.lastOptions?.env as Record<string, string>;
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-oauth");
  });

  it("forwards subagents, MCP servers and tool lists untouched", async () => {
    const fake = fakeQuery([initMessage(), successResult()]);
    const agents = { reviewer: { description: "reviews diffs", prompt: "review" } };
    await runAgent(config({ agents, allowedTools: ["Read"], disallowedTools: ["Bash"] }), deps(fake.run));
    expect(fake.lastOptions).toMatchObject({ agents, allowedTools: ["Read"], disallowedTools: ["Bash"] });
  });
});

describe("runAgent success", () => {
  it("returns the final text when no schema is supplied", async () => {
    const messages = [initMessage(), assistantMessage("thinking"), successResult({ result: "the answer" })];
    const result = await runAgent(config(), deps(fakeQuery(messages).run));
    expect(result).toMatchObject({ ok: true, output: "the answer", sessionId: SESSION_ID });
  });

  it("reports what the init message said about the session", async () => {
    const result = await runAgent(config(), deps(fakeQuery([initMessage(), successResult()]).run));
    expect(result.ok && result.init).toMatchObject({
      apiKeySource: "none",
      model: "claude-opus-5",
      tools: ["Read", "Bash"],
    });
  });

  it("asks the SDK for json_schema output and returns the parsed value", async () => {
    const schema = z.object({ verdict: z.string(), score: z.number() });
    const payload = { verdict: "ship it", score: 9 };
    const fake = fakeQuery([initMessage(), successResult({ structured_output: payload })]);
    const result = await runAgent(config({ outputSchema: schema }), deps(fake.run));
    expect(fake.lastOptions?.outputFormat).toMatchObject({ type: "json_schema" });
    expect(result).toMatchObject({ ok: true, output: payload });
  });

  it("reports the client-side cost estimate and turn count", async () => {
    const result = await runAgent(config(), deps(fakeQuery([initMessage(), successResult()]).run));
    expect(result.usage).toMatchObject({ totalCostUsd: 0.25, turns: 3 });
  });

  it("accumulates cost from the per-model breakdown when the result zeroes the total", async () => {
    const zeroed = successResult({
      total_cost_usd: 0,
      modelUsage: { "claude-opus-5": modelUsage(0.6), "claude-haiku-4-5": modelUsage(0.15) },
    });
    const result = await runAgent(config(), deps(fakeQuery([initMessage(), zeroed]).run));
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.75);
    expect(Object.keys(result.usage?.modelUsage ?? {})).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
  });

  it("streams every message to onMessage", async () => {
    const messages = [initMessage(), assistantMessage("one"), assistantMessage("two"), successResult()];
    const seen: SDKMessage[] = [];
    await runAgent(config({ onMessage: (m) => seen.push(m) }), deps(fakeQuery(messages).run));
    expect(seen).toHaveLength(4);
  });
});

describe("runAgent failures", () => {
  it.each([
    ["error_max_turns", "max_turns"],
    ["error_max_budget_usd", "budget_exceeded"],
    ["error_max_structured_output_retries", "schema_invalid"],
  ])("maps %s to %s and still reports usage", async (subtype, kind) => {
    const result = await runAgent(config(), deps(fakeQuery([initMessage(), errorResult(subtype)]).run));
    expect(result).toMatchObject({ ok: false, failure: { kind }, sessionId: SESSION_ID });
    expect(result.usage?.totalCostUsd).toBe(0.1);
  });

  it("maps rate-limit phrasing in an execution error and dates it from the rate_limit_event", async () => {
    const resetsAt = Date.UTC(2026, 8, 8, 18, 0, 0);
    const messages = [
      initMessage(),
      rateLimitEvent(resetsAt),
      errorResult("error_during_execution", ["You've hit your session limit"]),
    ];
    const result = await runAgent(config(), deps(fakeQuery(messages).run));
    expect(result).toMatchObject({ ok: false, failure: { kind: "rate_limited" } });
    expect(result.ok === false && (result.failure as { retryAt?: Date }).retryAt?.getTime()).toBe(resetsAt);
  });

  it("rejects structured output that does not match the caller's schema", async () => {
    const schema = z.object({ score: z.number() });
    const bad = successResult({ structured_output: { score: "nine" } });
    const result = await runAgent(config({ outputSchema: schema }), deps(fakeQuery([initMessage(), bad]).run));
    expect(result).toMatchObject({ ok: false, failure: { kind: "schema_invalid" } });
    expect(result.ok === false && result.failure.kind === "schema_invalid" && result.failure.error?.issues).toHaveLength(
      1,
    );
  });

  it("fails when the session never emits a result message", async () => {
    const result = await runAgent(config(), deps(fakeQuery([initMessage(), assistantMessage("hi")]).run));
    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: /result message/ } });
  });

  it("turns a thrown stream error into runtime_error", async () => {
    const fake = fakeQuery([initMessage()], { throwAtEnd: new Error("subprocess died") });
    const result = await runAgent(config(), deps(fake.run));
    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: "subprocess died" } });
    expect(fake.closed).toBe(true);
  });

  it("fails auth before starting when the OAuth token is missing", async () => {
    const fake = fakeQuery([initMessage(), successResult()]);
    const result = await runAgent(config(), { query: fake.run, env: {} });
    expect(result).toMatchObject({ ok: false, failure: { kind: "auth_misconfigured" } });
    expect(fake.lastOptions).toBeUndefined();
  });
});

describe("runAgent auth guard on the init message", () => {
  it("aborts the run when the session landed on env API-key billing", async () => {
    const messages = [
      initMessage({ apiKeySource: "ANTHROPIC_API_KEY" }),
      assistantMessage("should never be read"),
      successResult(),
    ];
    const fake = fakeQuery(messages);
    const result = await runAgent(config(), deps(fake.run));
    expect(result).toMatchObject({ ok: false, failure: { kind: "auth_misconfigured" } });
    expect(fake.yielded).toHaveLength(1);
    expect(fake.closed).toBe(true);
  });

  it("allows the same source when the caller opted into API-key billing", async () => {
    const messages = [initMessage({ apiKeySource: "ANTHROPIC_API_KEY" }), successResult()];
    const result = await runAgent(config({ allowApiKeyBilling: true }), {
      query: fakeQuery(messages).run,
      env: { ANTHROPIC_API_KEY: "sk-ant" },
    });
    expect(result.ok).toBe(true);
  });
});

describe("runAgent cancellation", () => {
  it("ends as aborted when the caller's signal fires mid-stream", async () => {
    const controller = new AbortController();
    const messages = [initMessage(), assistantMessage("one"), assistantMessage("two"), successResult()];
    const fake = fakeQuery(messages, {
      afterYield: (index) => {
        if (index === 1) controller.abort("caller changed its mind");
      },
    });
    const result = await runAgent(config({ signal: controller.signal }), deps(fake.run));
    expect(result).toMatchObject({ ok: false, failure: { kind: "aborted", reason: "caller changed its mind" } });
    expect(fake.yielded).toHaveLength(2);
    expect(fake.closed).toBe(true);
  });

  it("ends as aborted when the signal is already aborted", async () => {
    const fake = fakeQuery([initMessage(), successResult()]);
    const result = await runAgent(config({ signal: AbortSignal.abort("too late") }), deps(fake.run));
    expect(result).toMatchObject({ ok: false, failure: { kind: "aborted" } });
    expect(fake.yielded).toHaveLength(0);
  });

  it("ends as inactivity_timeout when the stream goes quiet", async () => {
    vi.useFakeTimers();
    const fake = fakeQuery([initMessage()], { hangAtEnd: true });
    const pending = runAgent(config({ inactivityTimeoutMs: 1_000 }), deps(fake.run));
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "inactivity_timeout", timeoutMs: 1_000, reason: "no message for 1000ms" },
    });
    expect(fake.closed).toBe(true);
  });

  it("resets the inactivity watchdog on every message", async () => {
    vi.useFakeTimers();
    const messages = [initMessage(), assistantMessage("one"), successResult()];
    const fake = fakeQuery(messages, { afterYield: () => vi.advanceTimersByTime(700) });
    const result = await runAgent(config({ inactivityTimeoutMs: 1_000 }), deps(fake.run));
    expect(result.ok).toBe(true);
  });

  it("defaults the watchdog to ten minutes", () => {
    expect(DEFAULT_INACTIVITY_MS).toBe(600_000);
  });
});
