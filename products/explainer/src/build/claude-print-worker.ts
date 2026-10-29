import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveClaudeBin, runAgent, type AgentUsage } from "@titan-design/agent";
import { priceRequest } from "@titan-design/agent-protocol/pricing";
import type { z } from "zod";
import { DEFAULT_DOCTRINE_DIR } from "../doctrine-load.js";
import { sha256 } from "../workflow/artifacts.js";
import type { StageUsage } from "../workflow/records.js";
import { LayerBuildSchema, type BeatWorker, type BuilderRef, type LayerBuild } from "./beat-worker.js";

/** The system prompt every claude-print build starts from; its sha is in every packet key. */
export const CUSTOM_LAYER_PROMPT = path.join(DEFAULT_DOCTRINE_DIR, "builders", "custom-layer.md");
export const CLAUDE_PRINT_LAYER_MODEL = "sonnet";
/** Bump when the call around the prompt or the checks after it change (schema, turns, budget, TP-4418 text check), so every layer is rebuilt. */
export const CLAUDE_PRINT_WORKER_VERSION = "c3";
const MAX_BUDGET_USD = 0.5;

/** What the model answers: the layer without spend, which the worker prices itself. */
export const LayerOutputSchema = LayerBuildSchema.pick({ module: true, anchors: true, elements: true }).strict();
export type LayerOutput = z.infer<typeof LayerOutputSchema>;

export interface ClaudePrintWorkerDeps {
  runAgent?: typeof runAgent;
  basePrompt?: string;
  cwd?: string;
  now?: () => Date;
}

/**
 * Spend priced from the per-model token counts at the price table, never from `total_cost_usd`, which a fork or resumed
 * session inflates with its parent's spend. A model the table lacks leaves the spend marked unknown.
 */
export function priceUsage(usage: Pick<AgentUsage, "modelUsage"> | undefined, at: Date): StageUsage {
  const models = Object.entries(usage?.modelUsage ?? {});
  const priced = models.map(([model, m]) => priceRequest({
    inputTokens: m.inputTokens, outputTokens: m.outputTokens, cacheReadTokens: m.cacheReadInputTokens, cacheCreationTokens: m.cacheCreationInputTokens,
  }, model, at.toISOString()));
  const sum = (pick: (m: (typeof models)[number][1]) => number) => models.reduce((total, [, m]) => total + pick(m), 0);
  return {
    usd: priced.reduce((total, p) => total + p.costUsd, 0),
    inputTokens: sum((m) => m.inputTokens), outputTokens: sum((m) => m.outputTokens),
    cacheReadTokens: sum((m) => m.cacheReadInputTokens), cacheWriteTokens: sum((m) => m.cacheCreationInputTokens),
    calls: 1, ...(priced.some((p) => !p.priced) ? { costUnknown: true as const } : {}),
  };
}

/** The one-shot builder: one tool-less `claude -p` call per packet, the base prompt as its system prompt. */
export function claudePrintWorker(deps: ClaudePrintWorkerDeps = {}): BeatWorker {
  const basePrompt = deps.basePrompt ?? readFileSync(CUSTOM_LAYER_PROMPT, "utf8");
  const run = deps.runAgent ?? runAgent;
  const now = deps.now ?? (() => new Date());
  const builder: BuilderRef = { id: "claude-print", version: CLAUDE_PRINT_WORKER_VERSION, model: CLAUDE_PRINT_LAYER_MODEL, basePromptSha: sha256(basePrompt) };
  return {
    builder,
    async build(packet, { signal }): Promise<LayerBuild> {
      const result = await run<LayerOutput>({
        harness: "claude-print", model: builder.model, systemPrompt: basePrompt, prompt: packet.json, outputSchema: LayerOutputSchema,
        maxTurns: 1, maxBudgetUsd: MAX_BUDGET_USD, cwd: deps.cwd ?? process.cwd(), ...(signal ? { signal } : {}),
      });
      if (!result.ok) throw new Error(`${packet.packet.beat_id}: claude-print ${result.failure.kind}: ${result.failure.reason}`);
      return { ...result.output, usage: priceUsage(result.usage, now()), sessionId: result.sessionId };
    },
  };
}

/**
 * The host's beat worker: the one it set, none when it set `null`, and claude-print by default when a `claude` binary
 * is on this host. With none, custom beats are left unbuilt with a note and the run goes on.
 */
export function beatWorkerFor(configured: BeatWorker | null | undefined, env: NodeJS.ProcessEnv = process.env): BeatWorker | undefined {
  if (configured !== undefined) return configured ?? undefined;
  const bin = resolveClaudeBin(Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  return bin ? claudePrintWorker() : undefined;
}
