import { z } from "zod";
import { JudgeConfigSchema, type JudgeConfig } from "../eval-harness.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import { sha256 } from "./artifacts.js";
import type { BridgeFile } from "./bridge.js";
import { isBridgeStage, CACHED_STAGES, type CachedStage } from "./records.js";

/**
 * Bumped when a stage's body changes what it makes from the same inputs, so an old cache entry is never read as
 * this body's output. It is also the child workflow's registered version.
 */
export const STAGE_VERSIONS: Record<CachedStage, string> = { script: "x3", rewrite: "x3", eval: "x3", tts: "x3", render: "x3", qa: "x3", sheets: "x3" };

/** The artifacts each in-process stage reads; a bridged stage reads what `bridge.json` declares as its inputs. */
const MODEL_INPUTS: Record<"script" | "rewrite" | "eval", readonly string[]> = { script: ["spine", "facts"], rewrite: ["draft"], eval: ["script", "spine"] };

/** A stage variant file: settings for one stage, whose content hash goes into the stage key. */
export const VariantSchema = z.object({
  schema: z.literal("explainer.variant/v1"),
  stage: z.enum(CACHED_STAGES),
  name: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type Variant = z.infer<typeof VariantSchema>;

const ScriptParamsSchema = z.strictObject({ model: z.string().min(1).optional() });
const RewriteParamsSchema = z.strictObject({ model: z.string().min(1).optional(), rounds: z.number().int().min(1).max(MAX_REWRITE_ROUNDS).optional() });

/** What a stage body runs with: the run's settings with the variant's params laid over them. */
export const StageConfigSchema = z.object({
  variant: z.object({ name: z.string(), sha: z.string() }).optional(),
  model: z.string().optional(),
  judge: JudgeConfigSchema.optional(),
  rounds: z.number().optional(),
  /** A bridged stage's own block of `bridge.json`, so an edited command misses the cache. */
  bridge: z.unknown().optional(),
  vars: z.record(z.string(), z.string()).optional(),
});
export type StageConfig = z.infer<typeof StageConfigSchema>;

/** Everything a child stage run needs; its param, so a resumed child rebuilds the same body. */
export const StageSpecSchema = z.object({
  stage: z.enum(CACHED_STAGES),
  key: z.string(),
  inputs: z.record(z.string(), z.string()),
  config: StageConfigSchema,
  sample: z.number().int().nonnegative(),
  /** Bounds a model call inside the stage; not part of the key. */
  remainingUsd: z.number(),
});
export type StageSpec = z.infer<typeof StageSpecSchema>;

export interface RunSettings {
  scriptModel: string;
  judge: JudgeConfig;
  rounds: number;
}

/** JSON with sorted keys at every depth, so equal values hash equal whatever order they were built in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `sha(stage, definition version, config with the variant, the inputs the stage reads, sample)`: never the outputs, which TTS does not reproduce byte for byte. */
export function stageKey(spec: Omit<StageSpec, "key" | "remainingUsd">): string {
  return sha256(canonicalJson({ stage: spec.stage, version: STAGE_VERSIONS[spec.stage], config: spec.config, inputs: spec.inputs, sample: spec.sample }));
}

function bridgeBlock(stage: CachedStage, bridge: () => BridgeFile) {
  const block = bridge().stages[stage as keyof BridgeFile["stages"]];
  if (!block) throw new Error(`bridge host file has no "${stage}" stage`);
  return block;
}

function bridgeConfig(stage: CachedStage, params: Variant["params"], bridge: () => BridgeFile): StageConfig {
  const block = bridgeBlock(stage, bridge);
  const unknown = Object.keys(params).filter((name) => block.vars[name] === undefined);
  if (unknown.length > 0) throw new Error(`variant for ${stage} sets ${unknown.join(", ")}, which its bridge.json block declares no default for in "vars"`);
  const vars = { ...block.vars, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) };
  return { bridge: block, vars };
}

function settingsConfig(stage: CachedStage, settings: RunSettings, params: Variant["params"], bridge: () => BridgeFile): StageConfig {
  if (stage === "script") return { model: ScriptParamsSchema.parse(params).model ?? settings.scriptModel };
  if (stage === "rewrite") {
    const p = RewriteParamsSchema.parse(params);
    return { judge: p.model ? { ...settings.judge, model: p.model } : settings.judge, rounds: p.rounds ?? settings.rounds };
  }
  if (stage === "eval") return z.strictObject({}).parse(params);
  return bridgeConfig(stage, params, bridge);
}

const inputNames = (stage: CachedStage, bridge: () => BridgeFile): readonly string[] =>
  isBridgeStage(stage) ? Object.keys(bridgeBlock(stage, bridge).inputs) : MODEL_INPUTS[stage as keyof typeof MODEL_INPUTS];

export interface SpecRequest {
  stage: CachedStage;
  artifacts: Readonly<Record<string, string>>;
  settings: RunSettings;
  variant?: { sha: string; value: Variant };
  sample: number;
  remainingUsd: number;
  bridge: () => BridgeFile;
}

/** Builds a stage's spec and key from what it reads; a missing input fails here, before any child run starts. */
export function stageSpec(request: SpecRequest): StageSpec {
  const { stage, variant } = request;
  if (variant && variant.value.stage !== stage) throw new Error(`variant "${variant.value.name}" is for stage ${variant.value.stage}, not ${stage}`);
  const inputs: Record<string, string> = {};
  for (const name of inputNames(stage, request.bridge)) {
    const sha = request.artifacts[name];
    if (sha === undefined) throw new Error(`stage ${stage} needs artifact "${name}", which no earlier stage produced and no --pin supplied`);
    inputs[name] = sha;
  }
  const config: StageConfig = {
    ...(variant ? { variant: { name: variant.value.name, sha: variant.sha } } : {}),
    ...settingsConfig(stage, request.settings, variant?.value.params ?? {}, request.bridge),
  };
  const keyed = { stage, inputs, config, sample: request.sample };
  return { ...keyed, key: stageKey(keyed), remainingUsd: request.remainingUsd };
}
