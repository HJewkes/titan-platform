import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexExecCapabilities, type AgentInit, type AgentRunConfig, type AgentRunResult, type AgentUsage, type CodexRunRequest, type HarnessAdapter, type HarnessRunResult, type runAgent } from "@titan-design/agent";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codexUnavailable, createJudgeHarness, JudgeConfigSchema } from "./eval-harness.js";

const schema = z.strictObject({ ok: z.boolean() });
const conversation = { harness: "codex", namespace: "explainer-eval", nativeId: "t-1" };
const execution = { executionId: "e-1", conversation };

/** A codex adapter that records its request and answers with the given result. */
function fakeCodex(result: HarnessRunResult<unknown, "codex">) {
  const requests: CodexRunRequest<unknown>[] = [];
  const adapter: HarnessAdapter<"codex"> = {
    descriptor: codexExecCapabilities(),
    run: async <T>(request: CodexRunRequest<T>) => {
      requests.push(request as CodexRunRequest<unknown>);
      return result as HarnessRunResult<T, "codex">;
    },
  };
  return { adapter, requests };
}

const usage = (input: number, output: number, sequence: number) => ({
  model: "gpt-x",
  tokens: { input, output, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null },
  cost: { usd: 0.01 * sequence, kind: "estimate" as const },
  source: "fake",
  kind: "snapshot" as const,
  scope: "conversation" as const,
  scopeId: "c-1",
  epoch: "e",
  sequence,
});

describe("createJudgeHarness", () => {
  it("runs a claude-print judge as one bounded, schema-bound turn on the configured model", async () => {
    const seen: AgentRunConfig<unknown>[] = [];
    const fakeRun = (async (config: AgentRunConfig<unknown>): Promise<AgentRunResult<unknown>> => {
      seen.push(config);
      const modelUsage = { haiku: partialFake<AgentUsage["modelUsage"][string]>({ inputTokens: 40, outputTokens: 5 }) };
      return { ok: true, output: { ok: true }, sessionId: "s", usage: { totalCostUsd: 0.002, modelUsage, turns: 1, durationMs: 10 }, init: partialFake<AgentInit>() };
    }) as typeof runAgent;
    const config = JudgeConfigSchema.parse({ provider: "claude-print", model: "haiku", max_budget_usd: 0.1 });

    const reply = await createJudgeHarness(config, { runAgent: fakeRun, cwd: "/tmp" })({ prompt: "p", schema });

    expect(seen[0]).toMatchObject({ harness: "claude-print", model: "haiku", maxTurns: 1, maxBudgetUsd: 0.1, outputSchema: schema, inactivityTimeoutMs: 600_000 });
    expect(reply).toEqual({ ok: true, output: { ok: true }, usd: 0.002, tokensIn: 40, tokensOut: 5 });
  });

  it("runs a codex judge read-only on the configured model and effort, counting only the latest usage snapshot", async () => {
    const ok: HarnessRunResult<unknown, "codex"> = { ok: true, harness: "codex", execution, conversation, output: { kind: "structured", value: { ok: true } }, usage: [usage(10, 1, 1), usage(30, 4, 2)] };
    const { adapter, requests } = fakeCodex(ok);
    const config = JudgeConfigSchema.parse({ provider: "codex", model: "gpt-x", reasoning_effort: "high", wall_time_s: 60 });

    const reply = await createJudgeHarness(config, { codexAdapter: () => adapter, cwd: "/tmp" })({ prompt: "p", schema });

    expect(requests[0]).toMatchObject({ harness: "codex", wallTimeMs: 60_000, native: { model: "gpt-x", reasoningEffort: "high", sandbox: "read-only" } });
    expect(requests[0]!.native!.outputSchema!.jsonSchema).not.toHaveProperty("$schema");
    expect(reply).toEqual({ ok: true, output: { ok: true }, usd: 0.02, tokensIn: 30, tokensOut: 4 });
  });

  it("parses a codex text answer through the schema and reports a failed run with its kind", async () => {
    const text: HarnessRunResult<unknown, "codex"> = { ok: true, harness: "codex", execution, conversation, output: { kind: "text", text: '{"ok":"yes"}' }, usage: [] };
    const failed: HarnessRunResult<unknown, "codex"> = { ok: false, harness: "codex", failure: { kind: "runtime_error", reason: "no cached login" }, usage: [] };
    const config = JudgeConfigSchema.parse({ provider: "codex", model: "gpt-x" });
    const call = (result: HarnessRunResult<unknown, "codex">) => createJudgeHarness(config, { codexAdapter: () => fakeCodex(result).adapter })({ prompt: "p", schema });

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
