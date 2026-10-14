import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexExecCapabilities, type AgentInit, type AgentRunConfig, type AgentRunResult, type AgentUsage, type CodexRunRequest, type HarnessAdapter, type HarnessRunFailure, type HarnessRunResult, type runAgent } from "@titan-design/agent";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codexUnavailable, createJudgeHarness, JudgeConfigSchema } from "./eval-harness.js";

const schema = z.strictObject({ ok: z.boolean() });
const conversation = { harness: "codex", namespace: "explainer-eval", nativeId: "t-1" };
const execution = { executionId: "e-1", conversation };

type CodexAnswer =
  | { output: { kind: "structured"; value: unknown } | { kind: "text"; text: string }; usage: ReturnType<typeof usage>[] }
  | { failure: HarnessRunFailure };

/** A codex adapter that records its request; a structured answer goes through the request's own schema, as the real one does. */
function fakeCodex(answer: CodexAnswer) {
  const requests: CodexRunRequest<unknown>[] = [];
  const adapter: HarnessAdapter<"codex"> = {
    descriptor: codexExecCapabilities(),
    run: async <T>(request: CodexRunRequest<T>): Promise<HarnessRunResult<T, "codex">> => {
      requests.push(request);
      if ("failure" in answer) return { ok: false, harness: "codex", failure: answer.failure, usage: [] };
      const output = answer.output.kind === "text" ? answer.output : { kind: "structured" as const, value: request.native!.outputSchema!.parse(answer.output.value) };
      return { ok: true, harness: "codex", execution, conversation, output, usage: answer.usage };
    },
  };
  return { adapter, requests };
}

function usage(input: number, output: number, sequence: number) {
  return {
    model: "gpt-x",
    tokens: { input, output, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null },
    cost: { usd: 0.01 * sequence, kind: "estimate" as const },
    source: "fake",
    kind: "snapshot" as const,
    scope: "conversation" as const,
    scopeId: "c-1",
    epoch: "e",
    sequence,
  };
}

describe("createJudgeHarness", () => {
  it("runs a claude-print judge as one bounded, schema-bound turn on the configured model", async () => {
    const seen: AgentRunConfig<unknown>[] = [];
    const fakeRun: typeof runAgent = async <T>(config: AgentRunConfig<T>): Promise<AgentRunResult<T>> => {
      seen.push(config);
      const output = config.outputSchema!.parse({ ok: true });
      const modelUsage = { haiku: partialFake<AgentUsage["modelUsage"][string]>({ inputTokens: 40, outputTokens: 5 }) };
      return { ok: true, output, sessionId: "s", usage: { totalCostUsd: 0.002, modelUsage, turns: 1, durationMs: 10 }, init: partialFake<AgentInit>() };
    };
    const config = JudgeConfigSchema.parse({ provider: "claude-print", model: "haiku", max_budget_usd: 0.1 });

    const reply = await createJudgeHarness(config, { runAgent: fakeRun, cwd: "/tmp" })({ prompt: "p", schema });

    expect(seen[0]).toMatchObject({ harness: "claude-print", model: "haiku", maxTurns: 1, maxBudgetUsd: 0.1, outputSchema: schema, inactivityTimeoutMs: 600_000 });
    expect(reply).toEqual({ ok: true, output: { ok: true }, usd: 0.002, tokensIn: 40, tokensOut: 5 });
  });

  it("runs a codex judge read-only on the configured model and effort, counting only the latest usage snapshot", async () => {
    const { adapter, requests } = fakeCodex({ output: { kind: "structured", value: { ok: true } }, usage: [usage(10, 1, 1), usage(30, 4, 2)] });
    const config = JudgeConfigSchema.parse({ provider: "codex", model: "gpt-x", reasoning_effort: "high", wall_time_s: 60 });

    const reply = await createJudgeHarness(config, { codexAdapter: () => adapter, cwd: "/tmp" })({ prompt: "p", schema });

    expect(requests[0]).toMatchObject({ harness: "codex", wallTimeMs: 60_000, native: { model: "gpt-x", reasoningEffort: "high", sandbox: "read-only" } });
    expect(requests[0]!.native!.outputSchema!.jsonSchema).not.toHaveProperty("$schema");
    expect(reply).toEqual({ ok: true, output: { ok: true }, usd: 0.02, tokensIn: 30, tokensOut: 4 });
  });

  it("parses a codex text answer through the schema and reports a failed run with its kind", async () => {
    const text: CodexAnswer = { output: { kind: "text", text: '{"ok":"yes"}' }, usage: [] };
    const failed: CodexAnswer = { failure: { kind: "runtime_error", reason: "no cached login" } };
    const config = JudgeConfigSchema.parse({ provider: "codex", model: "gpt-x" });
    const call = (result: CodexAnswer) => createJudgeHarness(config, { codexAdapter: () => fakeCodex(result).adapter })({ prompt: "p", schema });

    expect(await call(text)).toMatchObject({ ok: false, reason: expect.stringMatching(/^schema_invalid: /) });
    expect(await call(failed)).toMatchObject({ ok: false, reason: "runtime_error: no cached login" });
  });
});

describe("codexUnavailable", () => {
  it("names a missing binary, then a missing login, and is null once both exist", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const binary = join(home, "codex");

    expect(codexUnavailable({ executable_path: binary }, { CODEX_HOME: home })).toContain("codex is not installed at");
    writeFileSync(binary, "");
    expect(codexUnavailable({ executable_path: binary }, { CODEX_HOME: home })).toContain("codex is not logged in on this host");
    writeFileSync(join(home, "auth.json"), "{}");
    expect(codexUnavailable({ executable_path: binary }, { CODEX_HOME: home })).toBeNull();
  });
});
