import { readFileSync } from "node:fs";
import type { AgentRunConfig, AgentRunResult, AgentUsage, runAgent } from "@titan-design/agent";
import { describe, expect, it } from "vitest";
import { loadDoctrine } from "../doctrine-load.js";
import { findPromptLeaks } from "../doctrine-slice.js";
import { loadRuleRegistry } from "../rules.js";
import type { BeatWorker } from "./beat-worker.js";
import { beatWorkerFor, claudePrintWorker, CUSTOM_LAYER_PROMPT, LayerOutputSchema, type LayerOutput } from "./claude-print-worker.js";
import type { BuiltLayerPacket } from "./layer-packet.js";

// Synthetic: an invented parcel desk packet, a fake runAgent and a made-up session id; no live model call.
const BASE = "You build one custom layer for one beat of a parcel-desk explainer.";
const PACKET_JSON = `${JSON.stringify({ beat_id: "b1", spoken: "The desk holds each scan." })}\n`;
const PACKET = { packet: { beat_id: "b1" }, json: PACKET_JSON, bytes: PACKET_JSON.length } as unknown as BuiltLayerPacket;
const OUTPUT: LayerOutput = { module: `export default function Layer() {\n  return <div id="desk-card" />;\n}\n`, anchors: ["B2:E5"], elements: ["desk-card"] };
const AT = new Date("2026-10-24T00:00:00Z");

const modelUsage = (model: string, tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): AgentUsage["modelUsage"] => ({
  [model]: {
    inputTokens: tokens.input, outputTokens: tokens.output, cacheReadInputTokens: tokens.cacheRead ?? 0, cacheCreationInputTokens: tokens.cacheWrite ?? 0,
    webSearchRequests: 0, costUSD: 9.99, contextWindow: 200_000, maxOutputTokens: 64_000,
  },
});

/** A runAgent that records each config and answers with `result`. */
function fakeRunAgent(result: AgentRunResult<LayerOutput>) {
  const configs: AgentRunConfig<LayerOutput>[] = [];
  const run = (async (config: AgentRunConfig<LayerOutput>) => {
    configs.push(config);
    return result;
  }) as typeof runAgent;
  return { configs, run };
}

const succeeded = (usage: AgentUsage["modelUsage"]): AgentRunResult<LayerOutput> => ({
  ok: true, output: OUTPUT, sessionId: "session-fake-1", init: {} as never, usage: { totalCostUsd: 9.99, modelUsage: usage, turns: 1, durationMs: 10 },
});

const worker = (result: AgentRunResult<LayerOutput>) => {
  const fake = fakeRunAgent(result);
  return { ...fake, worker: claudePrintWorker({ runAgent: fake.run, basePrompt: BASE, cwd: "/tmp", now: () => AT }) };
};

describe("claudePrintWorker", () => {
  it("sends the base prompt as the system prompt and only the packet as the prompt, in one sonnet call", async () => {
    const { configs, worker: claude } = worker(succeeded(modelUsage("claude-sonnet-5-5", { input: 10, output: 5 })));

    await claude.build(PACKET, {});

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ harness: "claude-print", model: "sonnet", systemPrompt: BASE, prompt: PACKET_JSON, maxTurns: 1, maxBudgetUsd: 0.5 });
    expect(configs[0]!.outputSchema).toBe(LayerOutputSchema);
    expect(configs[0]!.prompt).not.toContain(BASE);
  });

  it("prices the build from its tokens at the price table, not from the reported total cost", async () => {
    const { worker: claude } = worker(succeeded(modelUsage("claude-sonnet-5-5", { input: 10_000, output: 2_000 })));

    const build = await claude.build(PACKET, {});

    expect(build.usage.usd).toBeCloseTo(0.04, 10);
    expect(build.usage).toMatchObject({ inputTokens: 10_000, outputTokens: 2_000, calls: 1 });
    expect(build.usage.costUnknown).toBeUndefined();
  });

  it("prices cache reads and writes at their own rates", async () => {
    const { worker: claude } = worker(succeeded(modelUsage("claude-sonnet-5-5", { input: 0, output: 0, cacheRead: 100_000, cacheWrite: 10_000 })));

    const build = await claude.build(PACKET, {});

    expect(build.usage.usd).toBeCloseTo(0.02 + 0.025, 10);
    expect(build.usage).toMatchObject({ cacheReadTokens: 100_000, cacheWriteTokens: 10_000 });
  });

  it("marks the spend unknown for a model the price table lacks", async () => {
    const { worker: claude } = worker(succeeded(modelUsage("synthetic-model-x", { input: 10, output: 5 })));

    const build = await claude.build(PACKET, {});

    expect(build.usage).toMatchObject({ usd: 0, costUnknown: true });
  });

  it("returns the model's layer with its session id", async () => {
    const { worker: claude } = worker(succeeded(modelUsage("claude-sonnet-5-5", { input: 10, output: 5 })));

    const build = await claude.build(PACKET, {});

    expect(build).toMatchObject({ ...OUTPUT, sessionId: "session-fake-1" });
  });

  it("throws naming the beat and the failure when the call fails", async () => {
    const { worker: claude } = worker({ ok: false, failure: { kind: "schema_invalid", reason: "structured output did not match" } as never });

    await expect(claude.build(PACKET, {})).rejects.toThrow("b1: claude-print schema_invalid: structured output did not match");
  });

  it("keys on the base prompt's sha, so an edited prompt is a different builder", () => {
    const a = claudePrintWorker({ basePrompt: BASE }).builder;
    const b = claudePrintWorker({ basePrompt: `${BASE} Edited.` }).builder;

    expect(a).toMatchObject({ id: "claude-print", model: "sonnet" });
    expect(a.basePromptSha).not.toBe(b.basePromptSha);
  });
});

describe("the custom-layer base prompt", () => {
  it("names no code-enforced rule", () => {
    const prompt = readFileSync(CUSTOM_LAYER_PROMPT, "utf8");

    expect(findPromptLeaks(prompt, loadDoctrine(), loadRuleRegistry())).toEqual([]);
  });
});

describe("beatWorkerFor", () => {
  const fake: BeatWorker = { builder: { id: "agent-chat", version: "1", model: "m", basePromptSha: "s" }, build: async () => { throw new Error("unused"); } };

  it("uses claude-print when the host sets no worker and a claude binary is configured", () => {
    expect(beatWorkerFor(undefined, { CLAUDE_BIN: "/opt/fake/claude", PATH: "" })?.builder).toMatchObject({ id: "claude-print", model: "sonnet" });
  });

  it("uses no worker when the host sets none and no claude binary can be found", () => {
    expect(beatWorkerFor(undefined, { PATH: "" })).toBeUndefined();
  });

  it("keeps the host's own worker, and none when the host sets null", () => {
    expect(beatWorkerFor(fake, { CLAUDE_BIN: "/opt/fake/claude" })).toBe(fake);
    expect(beatWorkerFor(null, { CLAUDE_BIN: "/opt/fake/claude" })).toBeUndefined();
  });
});
