import { z } from "zod";
import { SPEECH_BANDS, type SpeechBand } from "../beat-schema.js";
import { BuilderRefSchema, type BuilderRef } from "../build/beat-worker.js";
import { JudgeConfigSchema, type JudgeConfig } from "../eval-harness.js";
import { canonicalJson } from "../eval-store.js";
import { loadProfiles, profileFor } from "../profile-load.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import { loadSpeechBands } from "../speech-bands.js";
import { loadStylePacks, stylePackCss, stylePackFor, stylePackSha } from "../style-pack-load.js";
import type { StylePack } from "../style-pack-schema.js";
import { sha256 } from "./artifacts.js";
import { resolveConfig } from "../resolve-stage.js";
import { auditionConfig, profileRef } from "./audition-stage.js";
import { GatherRequestSchema, type GatherRequest } from "./run-gather.js";
import type { BridgeFile } from "./bridge.js";
import { isBridgeStage, CACHED_STAGES, type BridgeStage, type CachedStage } from "./records.js";

/**
 * Bumped when a stage's body changes what it makes from the same inputs, so an old cache entry is never read as
 * this body's output. It is also the child workflow's registered version.
 */
export const STAGE_VERSIONS: Record<CachedStage, string> = {
  gather: "g2", audition: "pp10", script: "x8", rewrite: "x4", eval: "x6", resolve: "p5c1", tts: "p6b", render: "x4", qa: "x4", sheets: "x4",
};

/** The artifacts each in-process stage reads; a bridged stage reads what `bridge.json` declares as its inputs. */
const IN_PROCESS_INPUTS: Record<Exclude<CachedStage, BridgeStage>, readonly string[]> = {
  gather: [], audition: ["facts"], script: ["spine", "facts"], rewrite: ["draft"], eval: ["script", "spine"], resolve: ["script"], tts: ["script", "resolved"],
};

/** Artifacts a stage reads when a pin or an earlier stage supplies them; absent, they stay out of its key. */
const OPTIONAL_INPUTS: Partial<Record<CachedStage, readonly string[]>> = {
  script: ["coverage"], rewrite: ["facts", "coverage"], eval: ["facts", "coverage"], resolve: ["code", "slots", "layout", "chapter-links", "facts", "custom-layers"],
};

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
const TtsParamsSchema = z.strictObject({ voice: z.string().min(1).optional(), rate: z.number().min(0.5).max(2).optional() });

/** The voice a run with no profile speaks in: the bridge's voice at Kokoro's natural rate. */
export const DEFAULT_VOICE = { id: "af_heart", rate: 1 } as const;

/** What a stage body runs with: the run's settings with the variant's params laid over them. */
export const StageConfigSchema = z.object({
  variant: z.object({ name: z.string(), sha: z.string() }).optional(),
  /** The gather stage's request: its adapter and everything that adapter reads. */
  gather: GatherRequestSchema.optional(),
  model: z.string().optional(),
  judge: JudgeConfigSchema.optional(),
  rounds: z.number().optional(),
  /** The run's profile, by version and content hash: the audition reads it and the script stage stamps its type. */
  profile: z.object({ type: z.string(), version: z.string(), sha: z.string() }).optional(),
  structures: z.string().optional(),
  /** The resolve stage's beat specs, profiles and router, by content hash. */
  doctrine: z.string().optional(),
  /** A bridged stage's own block of `bridge.json`, so an edited command misses the cache. */
  bridge: z.unknown().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  /** The tts stage's voice band: the profile's, with a tts variant's `voice` and `rate` over it. */
  voice: z.object({ id: z.string(), rate: z.number(), source: z.string() }).optional(),
  /** The tts stage's words a minute per speech band, from doctrine `speech-bands.yaml`, so a band edit re-voices. */
  rates: z.record(z.enum(SPEECH_BANDS), z.number()).optional(),
  /** The render variant's style pack, by content hash, so an edit to the pack's file misses the cache. */
  stylePack: z.object({ id: z.string(), sha: z.string() }).optional(),
  /** Who builds resolve's custom layers, so a new builder or base prompt misses the cache. */
  builder: BuilderRefSchema.optional(),
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
  /** The video type whose profile the audition reads; a run with no audition has none. */
  profile?: string;
  /** What the gather stage gathers; a run that starts later has none. */
  gather?: GatherRequest;
}

/** `sha(stage, definition version, config with the variant, the inputs the stage reads, sample)`: never the outputs, which TTS does not reproduce byte for byte. */
export function stageKey(spec: Omit<StageSpec, "key" | "remainingUsd">): string {
  return sha256(canonicalJson({ stage: spec.stage, version: STAGE_VERSIONS[spec.stage], config: spec.config, inputs: spec.inputs, sample: spec.sample }));
}

function bridgeBlock(stage: BridgeStage, bridge: () => BridgeFile) {
  const block = bridge().stages[stage];
  if (!block) throw new Error(`bridge host file has no "${stage}" stage`);
  return block;
}

function bridgeConfig(stage: BridgeStage, params: Variant["params"], bridge: () => BridgeFile): StageConfig {
  const block = bridgeBlock(stage, bridge);
  const unknown = Object.keys(params).filter((name) => block.vars[name] === undefined);
  if (unknown.length > 0) throw new Error(`variant for ${stage} sets ${unknown.join(", ")}, which its bridge.json block declares no default for in "vars"`);
  const vars = { ...block.vars, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) };
  return { bridge: block, vars };
}

/** Read when the spec is built, so a profile's new voice is a new key. */
function ttsVoice(profile: string | undefined, params: z.infer<typeof TtsParamsSchema>): NonNullable<StageConfig["voice"]> {
  const band = profile ? profileFor(loadProfiles(), profile).voice : DEFAULT_VOICE;
  const source = params.voice !== undefined || params.rate !== undefined ? "variant" : profile ? `profile ${profile}` : "default";
  return { id: params.voice ?? band.id, rate: params.rate ?? band.rate, source };
}

/** Read when the spec is built, like the voice, so an edited band rate is a new key. */
function bandRates(): Record<SpeechBand, number> {
  const { story, concept, code, takeaways, held } = loadSpeechBands();
  return { story: story.wpm, concept: concept.wpm, code: code.wpm, takeaways: takeaways.wpm, held: held.wpm };
}

function settingsConfig(stage: CachedStage, settings: RunSettings, params: Variant["params"], bridge: () => BridgeFile): StageConfig {
  if (stage === "gather") {
    z.strictObject({}).parse(params);
    if (!settings.gather) throw new Error("stage gather needs a gather request: pass --facts-from <adapter> with its flags");
    return { gather: settings.gather };
  }
  if (stage === "audition") {
    z.strictObject({}).parse(params);
    if (!settings.profile) throw new Error("stage audition needs a profile: pass --profile <type>");
    return auditionConfig(settings.profile, { model: settings.scriptModel, judge: settings.judge });
  }
  if (stage === "script") {
    const model = ScriptParamsSchema.parse(params).model ?? settings.scriptModel;
    return { model, ...(settings.profile ? { profile: profileRef(settings.profile) } : {}) };
  }
  if (stage === "rewrite") {
    const p = RewriteParamsSchema.parse(params);
    return { judge: p.model ? { ...settings.judge, model: p.model } : settings.judge, rounds: p.rounds ?? settings.rounds };
  }
  if (stage === "eval") return { ...z.strictObject({}).parse(params), judge: settings.judge };
  if (stage === "resolve") return { ...z.strictObject({}).parse(params), ...resolveConfig() };
  if (stage === "tts") return { voice: ttsVoice(settings.profile, TtsParamsSchema.parse(params)), rates: bandRates() };
  return bridgeConfig(stage, params, bridge);
}

const inputNames = (stage: CachedStage, bridge: () => BridgeFile): readonly string[] =>
  isBridgeStage(stage) ? Object.keys(bridgeBlock(stage, bridge).inputs) : IN_PROCESS_INPUTS[stage];

export interface SpecRequest {
  stage: CachedStage;
  artifacts: Readonly<Record<string, string>>;
  settings: RunSettings;
  variant?: { sha: string; value: Variant };
  sample: number;
  remainingUsd: number;
  bridge: () => BridgeFile;
  /** The style packs a render variant's `stylePack` param picks from; the shipped ones by default. */
  stylePacks?: () => ReadonlyMap<string, StylePack>;
  /** The beat worker's builder, which only the resolve stage's key carries; absent, custom beats stay unbuilt. */
  builder?: BuilderRef;
}

let shipped: ReadonlyMap<string, StylePack> | undefined;
const shippedStylePacks = (): ReadonlyMap<string, StylePack> => (shipped ??= loadStylePacks());

interface StyleChoice {
  stylePack: { id: string; sha: string };
  vars: Record<string, string>;
}

/** The render variant param that picks a style pack (plan §A.2): the pack is a render setting, never a TTS one. */
export const STYLE_PACK_PARAM = "stylePack";

/**
 * Lifts the style pack out of a render variant's params: the pack's id, theme and CSS reach the bridge as
 * `{var.stylePack}`, `{var.styleTheme}` and `{var.styleCss}`, and its content hash goes into the config.
 */
function styleConfig(stage: CachedStage, params: Variant["params"], packs: () => ReadonlyMap<string, StylePack>): { params: Variant["params"]; style?: StyleChoice } {
  const { [STYLE_PACK_PARAM]: id, ...rest } = params;
  if (id === undefined) return { params };
  if (stage !== "render") throw new Error(`variant for ${stage} sets ${STYLE_PACK_PARAM}, which only a render variant may set`);
  const pack = stylePackFor(packs(), String(id));
  const vars = { stylePack: pack.id, styleTheme: pack.theme, styleCss: stylePackCss(pack) };
  return { params: rest, style: { stylePack: { id: pack.id, sha: stylePackSha(pack) }, vars } };
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
  for (const name of OPTIONAL_INPUTS[stage] ?? []) {
    const sha = request.artifacts[name];
    if (sha !== undefined) inputs[name] = sha;
  }
  const { params, style } = styleConfig(stage, variant?.value.params ?? {}, request.stylePacks ?? shippedStylePacks);
  const settings = settingsConfig(stage, request.settings, params, request.bridge);
  const config: StageConfig = {
    ...(variant ? { variant: { name: variant.value.name, sha: variant.sha } } : {}),
    ...settings,
    ...(style ? { stylePack: style.stylePack, vars: { ...settings.vars, ...style.vars } } : {}),
    ...(stage === "resolve" && request.builder ? { builder: request.builder } : {}),
  };
  const keyed = { stage, inputs, config, sample: request.sample };
  return { ...keyed, key: stageKey(keyed), remainingUsd: request.remainingUsd };
}
