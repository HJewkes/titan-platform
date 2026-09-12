import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClaudeCodeAdapter } from "./claude-code-adapter.js";
import { fakeQuery, initMessage, successResult, modelUsage, SESSION_ID } from "./fake-query.js";
import type { ClaudeCodeRunRequest, HarnessRunProgress } from "./harness-contracts.js";

const env = { CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-for-test", PATH: "/usr/bin" };
function request<T = string>(extra: Partial<ClaudeCodeRunRequest<T>> = {}): ClaudeCodeRunRequest<T> {
  return { harness: "claude-code", prompt: "test", cwd: "/tmp", target: { kind: "fresh", namespace: "local" }, wallTimeMs: 1000, ...extra };
}
afterEach(() => vi.useRealTimers());

describe("bounded Claude adapter", () => {
  it("preserves mandatory native budgets, emits identities, and reports query usage", async () => {
    const fake = fakeQuery([initMessage(), successResult({ result: "answer" })]);
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 1, deps: { query: fake.run, env } });
    const progress: HarnessRunProgress[] = [];
    const result = await adapter.run(request({ onProgress: value => progress.push(value) }));
    expect(result).toMatchObject({ ok: true, harness: "claude-code", conversation: { nativeId: SESSION_ID, namespace: "local" }, output: { kind: "text", text: "answer" } });
    expect(fake.lastOptions).toMatchObject({ maxTurns: 3, maxBudgetUsd: 1, settingSources: [], permissionMode: "dontAsk" });
    expect(progress.map(value => value.kind)).toEqual(["execution_started", "conversation_identified", "execution_finished"]);
    expect(result.usage[0]).toMatchObject({ kind: "snapshot", scope: "turn", cost: { kind: "estimate" } });
    expect(fake.closed).toBe(true);
  });

  it("combines multi-model query totals into one snapshot without replacement collisions", async () => {
    const fake = fakeQuery([initMessage(), successResult({ total_cost_usd: 2,
      modelUsage: { first: { ...modelUsage(1.25), cacheReadInputTokens: 30, cacheCreationInputTokens: 10 },
        second: { ...modelUsage(0.75), cacheReadInputTokens: 20, cacheCreationInputTokens: 7 } } })]);
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 4, deps: { query: fake.run, env } });
    const result = await adapter.run(request());
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({ model: null, tokens: { input: 267, output: 100, cachedInput: 50, cacheWriteInput: 17 }, cost: { usd: 2, kind: "estimate" } });
  });

  it("reports native inactivity consistently as unconfirmed cancellation", async () => {
    vi.useFakeTimers();
    const fake = fakeQuery([initMessage()], { hangAtEnd: true });
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 1, inactivityTimeoutMs: 5, deps: { query: fake.run, env } });
    const progress: HarnessRunProgress[] = [];
    const pending = adapter.run(request({ onProgress: event => progress.push(event) }));
    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toMatchObject({ ok: false, failure: { kind: "cancelled_unknown" } });
    expect(progress.at(-1)).toMatchObject({ kind: "execution_finished", outcome: "cancelled" });
    expect(fake.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes the exact native conversation without reusing an invocation identity", async () => {
    const fake = fakeQuery([initMessage(), successResult()]);
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 1, deps: { query: fake.run, env } });
    const conversation = { harness: "claude-code", namespace: "local", nativeId: SESSION_ID };
    const first = await adapter.run(request({ target: { kind: "resume", conversation } }));
    const second = await adapter.run(request({ target: { kind: "resume", conversation } }));
    expect(fake.lastOptions?.resume).toBe(SESSION_ID);
    expect(first.conversation).toEqual(conversation);
    expect(second.conversation).toEqual(conversation);
    expect(first.execution?.executionId).not.toBe(second.execution?.executionId);
  });

  it("validates structured output using the caller's native schema", async () => {
    const fake = fakeQuery([initMessage(), successResult({ structured_output: { verdict: "pass" } })]);
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 1, deps: { query: fake.run, env } });
    const result = await adapter.run(request({ native: { outputSchema: z.object({ verdict: z.string() }) } }));
    expect(result).toMatchObject({ ok: true, output: { kind: "structured", value: { verdict: "pass" } } });
  });

  it("rejects unproved generic hard limits and pre-aborted requests before query launch", async () => {
    const fake = fakeQuery([]);
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 1, deps: { query: fake.run, env } });
    const limited = await adapter.run(request({ limits: [{ unit: "model_requests", value: 3, scope: "execution", enforcement: "hard" }] }));
    expect(limited).toMatchObject({ ok: false, failure: { kind: "unsupported_requirement" } });
    const aborted = await adapter.run(request({ signal: AbortSignal.abort("before launch") }));
    expect(aborted).toMatchObject({ ok: false, failure: { kind: "aborted" } });
    expect(fake.lastOptions).toBeUndefined();
  });

  it("bounds a stuck query by local deadline and closes the owned stream", async () => {
    vi.useFakeTimers();
    const fake = fakeQuery([initMessage()], { hangAtEnd: true });
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 1, deps: { query: fake.run, env } });
    const pending = adapter.run(request({ wallTimeMs: 20 }));
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ ok: false, failure: { kind: "wall_time_exceeded" } });
    expect(fake.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a live query when its external signal aborts without claiming native cancellation", async () => {
    const controller = new AbortController();
    const fake = fakeQuery([initMessage()], { hangAtEnd: true, afterYield: () => controller.abort("stop") });
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 1, deps: { query: fake.run, env } });
    expect(await adapter.run(request({ signal: controller.signal }))).toMatchObject({ ok: false, failure: { kind: "aborted" } });
    expect(fake.closed).toBe(true);
  });

  it("closes on a throwing observer and rejects a changed resume conversation", async () => {
    const fake = fakeQuery([initMessage(), successResult()]);
    const adapter = createClaudeCodeAdapter({ maxTurns: 3, maxBudgetUsd: 1, deps: { query: fake.run, env } });
    const result = await adapter.run(request({ onProgress: event => { if (event.kind === "conversation_identified") throw new Error("observer failed"); } }));
    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error" } });
    expect(fake.closed).toBe(true);
    const resumed = await adapter.run(request({ target: { kind: "resume", conversation: { harness: "claude-code", namespace: "local", nativeId: "different" } } }));
    expect(resumed).toMatchObject({ ok: false, failure: { kind: "runtime_error" } });
  });
});
