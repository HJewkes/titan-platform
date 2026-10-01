import { z } from "zod";
import { count, jsonSchema, modelId, nonempty, objectFor, promptRef, relativePath, sha256, specId, unitRef, usd } from "./common.js";
import type { SpecParseMode } from "./common.js";

export const VARIANT_SCHEMA_VERSION = "titan.variant/v1";
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const ON_RESTART = z.enum(["repeat", "park"]);

function runnerRef(mode: SpecParseMode) {
  const object = objectFor(mode);
  return z.discriminatedUnion("via", [
    object({ via: z.literal("agent"), harness: z.enum(["claude-code", "codex"]) }),
    object({ via: z.literal("agent-dispatch"), profile: nonempty, isolation: z.enum(["none", "worktree"]) }),
  ]);
}

function agentStep(mode: SpecParseMode) {
  const object = objectFor(mode);
  const tools = z.array(nonempty).optional();
  return object({
    kind: z.literal("agent"),
    runner: runnerRef(mode),
    model: modelId(mode),
    effort: z.enum(EFFORT_LEVELS).optional(),
    prompt: promptRef(mode),
    systemPrompt: promptRef(mode).optional(),
    maxTurns: count,
    maxBudgetUsd: usd,
    tools,
    allowedTools: tools,
    disallowedTools: tools,
    mcpServers: z.array(object({ name: nonempty, config: z.record(z.string(), z.unknown()).optional() })).optional(),
    skills: z.array(object({ name: nonempty, source: nonempty, treeSha256: sha256 })),
    outputSchema: jsonSchema.optional(),
    onRestart: ON_RESTART,
  });
}

function stepSchema(mode: SpecParseMode) {
  const object = objectFor(mode);
  return z.discriminatedUnion("kind", [
    object({ kind: z.literal("code"), onRestart: ON_RESTART }),
    object({ kind: z.literal("gate"), schema: jsonSchema.optional() }),
    object({ kind: z.literal("unit"), unit: specId, variant: nonempty }),
    object({
      kind: z.literal("llm"),
      model: modelId(mode),
      effort: z.enum(EFFORT_LEVELS).optional(),
      prompt: promptRef(mode),
      maxBudgetUsd: usd,
      outputSchema: jsonSchema.optional(),
    }),
    agentStep(mode),
  ]);
}

export function variantSchema(mode: SpecParseMode) {
  const object = objectFor(mode);
  return object({
    schema: z.literal(VARIANT_SCHEMA_VERSION),
    unit: unitRef(mode),
    id: specId,
    topology: object({ module: relativePath, export: nonempty, sourceSha256: sha256 }),
    steps: z.record(nonempty, stepSchema(mode)),
    parents: z.array(sha256).optional(),
    notes: z.string().optional(),
  });
}
