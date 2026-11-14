import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meterJob } from "./meter.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meter-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TS = "2026-11-14T04:48:13.481Z";

function request(model: string, effort: string) {
  return { type: "api-request", params: { model, output_config: { effort } } };
}

function assistant(id: string, model: string, usage: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    timestamp: TS,
    isSidechain: false,
    message: {
      id,
      model,
      usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 649, cache_creation_input_tokens: 1556, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 556 }, ...usage },
    },
    ...extra,
  };
}

async function meter(lines: object[], arm: { model: string; effort: string }, cliResult?: unknown) {
  const transcriptPath = join(dir, "t.jsonl");
  writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return meterJob({ transcriptPath, arm: { id: "arm", ...arm }, cliResult });
}

const OPUS = { model: "claude-opus-5-5", effort: "high" };
const FABLE = { model: "claude-fable-5-2", effort: "high" };

describe("meterJob", () => {
  it("counts two lines sharing a message id once and splits the cache write by ttl", async () => {
    const line = assistant("msg_1", OPUS.model);
    const result = await meter([request(OPUS.model, "high"), line, line], OPUS);
    expect(result.tokens[OPUS.model]).toEqual({ input: 2, output: 4, cacheRead: 649, cacheWrite5m: 1000, cacheWrite1h: 556 });
    expect(result.outcome).toBe("ok");
    expect(result.listUsd).toBeGreaterThan(0);
  });

  it("flags arm-mismatch when the request was sent at another effort", async () => {
    const result = await meter([request(OPUS.model, "medium"), assistant("msg_1", OPUS.model)], OPUS);
    expect(result.effortSeen).toEqual(["medium"]);
    expect(result.outcome).toBe("arm-mismatch");
  });

  it("flags arm-mismatch when the request went to another model", async () => {
    const result = await meter([request("claude-sonnet-5-5", "high")], OPUS);
    expect(result.modelSeen).toEqual(["claude-sonnet-5-5"]);
    expect(result.outcome).toBe("arm-mismatch");
  });

  it("prices a model with no price row from the CLI cost", async () => {
    const cliResult = { modelUsage: { [FABLE.model]: { costUSD: 0.0294458 } } };
    const result = await meter([request(FABLE.model, "high"), assistant("msg_1", FABLE.model)], FABLE, cliResult);
    expect(result.listUsd).toBeCloseTo(0.0294458, 10);
    expect(result.cliMismatch).toBe(false);
  });

  it("returns null list cost when neither the table nor the CLI can price the model", async () => {
    const result = await meter([assistant("msg_1", FABLE.model)], FABLE);
    expect(result.listUsd).toBeNull();
  });

  it("flags a CLI cost more than 1 percent from the transcript sum, and accepts a closer one", async () => {
    const lines = [request(OPUS.model, "high"), assistant("msg_1", OPUS.model)];
    const { listUsd } = await meter(lines, OPUS);
    const cli = (factor: number) => ({ modelUsage: { [OPUS.model]: { costUSD: listUsd! * factor } } });
    expect((await meter(lines, OPUS, cli(1.02))).cliMismatch).toBe(true);
    expect((await meter(lines, OPUS, cli(1.005))).cliMismatch).toBe(false);
  });

  it("counts sidechain lines and survives a torn last line", async () => {
    const transcriptPath = join(dir, "t.jsonl");
    writeFileSync(transcriptPath, [JSON.stringify(assistant("msg_1", OPUS.model, {}, { isSidechain: true })), '{"type":"assi'].join("\n"));
    const result = await meterJob({ transcriptPath, arm: { id: "arm", ...OPUS } });
    expect(result.sidechainLines).toBe(1);
    expect(result.tokens[OPUS.model]?.output).toBe(4);
  });
});
