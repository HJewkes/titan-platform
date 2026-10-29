import { describe, expect, it, vi } from "vitest";

const runAgent = vi.hoisted(() => vi.fn());
vi.mock("@titan-design/agent", () => ({ runAgent }));

const { claudeScoreRunner } = await import("./claude-runner.js");

const usage = {
  totalCostUsd: 0.07,
  modelUsage: { "model-a": { inputTokens: 100, cacheReadInputTokens: 20, cacheCreationInputTokens: 5, outputTokens: 40 } },
};
const call = { prompt: "p", systemPrompt: "s", model: "model-a", maxBudgetUsd: 0.25 };

describe("claude score runner", () => {
  it("keeps the billed usage and raw output of a failed call", async () => {
    runAgent.mockResolvedValueOnce({ ok: false, failure: { kind: "schema_invalid", reason: "bad", raw: { novelty: 9 } }, usage });

    const outcome = await claudeScoreRunner(call);

    expect(outcome).toEqual({
      ok: false,
      errorClass: "schema_invalid",
      message: "bad",
      usage: { costUsd: 0.07, inputTokens: 125, outputTokens: 40 },
      raw: { novelty: 9 },
    });
  });

  it("reports no usage when the harness billed nothing", async () => {
    runAgent.mockResolvedValueOnce({ ok: false, failure: { kind: "runtime_error", reason: "no start" } });

    const outcome = await claudeScoreRunner(call);

    expect(outcome).toMatchObject({ ok: false, errorClass: "other" });
    expect(outcome).not.toHaveProperty("usage");
  });
});
