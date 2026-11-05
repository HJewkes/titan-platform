import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { afterEach, describe, expect, it } from "vitest";
import { transcriptMeter } from "./step-usage.js";

const MODEL = "claude-sonnet-5-5";
const ROUND_ONE = "2026-10-21T10:00:00.000Z";
const ROUND_TWO = "2026-10-21T11:00:00.000Z";
const SINCE_ROUND_TWO = Date.parse("2026-10-21T10:30:00.000Z");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const assistant = (id: string, timestamp: string, inputTokens: number, model = MODEL, cache: object = {}) => JSON.stringify({ type: "assistant", sessionId: "s", cwd: "/tmp/demo", uuid: `u-${id}`, timestamp, requestId: id,
  message: { role: "assistant", id, model, usage: { input_tokens: inputTokens, output_tokens: 1_000, ...cache }, content: [{ type: "text", text: "ok" }] } });

function rowOver(lines: string[]): AgentRow {
  const dir = mkdtempSync(join(tmpdir(), "step-usage-"));
  dirs.push(dir);
  const transcriptPath = join(dir, "s.jsonl");
  writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
  return { name: "bs-demo", agentId: "a", state: "exited", presence: "exited", status: "finished", profile: "bd-implementer", surface: "headless", cwd: "/tmp/demo", sessionId: "s", generation: 1, transcriptPath, transcriptExists: true };
}

describe("the transcript meter", () => {
  it("prices only the requests of this turn, so a resumed lineage's earlier rounds are not counted again", async () => {
    const whole = await transcriptMeter(rowOver([assistant("r1", ROUND_ONE, 40_000), assistant("r2", ROUND_TWO, 10_000)]), 0);
    const lastTurn = await transcriptMeter(rowOver([assistant("r1", ROUND_ONE, 40_000), assistant("r2", ROUND_TWO, 10_000)]), SINCE_ROUND_TWO);

    expect(lastTurn?.costUsd).toBeGreaterThan(0);
    expect(lastTurn?.costUsd).toBeLessThan(whole!.costUsd);
    expect(lastTurn).toMatchObject({ model: MODEL, outputTokens: 1_000, peakContextTokens: 10_000 });
    expect(whole?.peakContextTokens).toBe(40_000);
  });

  it("takes peak context as the whole prompt, cache reads and writes included", async () => {
    const cached = { cache_read_input_tokens: 90_000, cache_creation_input_tokens: 7_000, cache_creation: { ephemeral_5m_input_tokens: 7_000, ephemeral_1h_input_tokens: 0 } };

    const usage = await transcriptMeter(rowOver([assistant("r1", ROUND_TWO, 3_000, MODEL, cached)]), 0);

    expect(usage?.peakContextTokens).toBe(100_000);
  });

  it("marks a model with no price row as unknown spend", async () => {
    const usage = await transcriptMeter(rowOver([assistant("r1", ROUND_TWO, 10_000, "unlisted-model")]), 0);

    expect(usage).toMatchObject({ costUsd: 0, costUnknown: true });
  });

  it("reads nothing from a row with no transcript yet", async () => {
    const row = { ...rowOver([assistant("r1", ROUND_TWO, 10_000)]), transcriptExists: false };

    await expect(transcriptMeter(row, 0)).resolves.toBeUndefined();
  });

  it("counts a response written over several lines once", async () => {
    const once = await transcriptMeter(rowOver([assistant("r1", ROUND_TWO, 10_000)]), 0);
    const repeated = await transcriptMeter(rowOver([assistant("r1", ROUND_TWO, 10_000), assistant("r1", ROUND_TWO, 10_000)]), 0);

    expect(repeated?.costUsd).toBe(once?.costUsd);
  });
});
