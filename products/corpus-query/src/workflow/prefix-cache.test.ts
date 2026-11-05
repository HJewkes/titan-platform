import { tmpdir } from "node:os";
import { runAgent } from "@titan-design/agent";
import { describe, expect, it } from "vitest";
import { buildBatches, buildJudgePrefix, prefixSha, SCREEN_ROLE } from "../judge/index.js";
import { SPEC } from "./fake-judges.test-helpers.js";

/**
 * A real `claude -p` call on the CLI login, so it is opt-in: `CORPUS_QUERY_SMOKE=1`. A harness that loads tools,
 * MCP servers, settings or skills adds about 29k tokens to every call; bare, the prompt is the prefix plus the batch.
 */
describe.skipIf(!process.env.CORPUS_QUERY_SMOKE)("judge call on the real CLI", () => {
  it("keeps the whole prompt, harness overhead included, under 5k tokens", async () => {
    const prefix = buildJudgePrefix({ role: SCREEN_ROLE, question: "List every trophy the Gull Rovers won", spec: SPEC });
    const [batch] = buildBatches([{ id: "gull-rovers/1/1#p0-2@00000000", ref: "GR 1.1", text: "The Gull Rovers won the Pebble Cup after extra time." }], {
      tokenBudget: 6000,
      prefixSha: prefixSha(prefix),
      canaries: [],
    });

    const result = await runAgent({ harness: "claude-print", prompt: batch!.message, cwd: tmpdir(), maxTurns: 1, maxBudgetUsd: 0.2, model: "haiku", systemPrompt: prefix });

    const models = Object.values(result.usage?.modelUsage ?? {});
    const promptTokens = models.reduce((sum, m) => sum + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0);
    expect(promptTokens).toBeGreaterThan(0);
    expect(promptTokens).toBeLessThan(5000);
  }, 120_000);
});
