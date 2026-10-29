import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SPEECH_BANDS, type SpeechBand } from "../beat-schema.js";
import { BuilderRefSchema, type BuilderRef } from "../build/beat-worker.js";
import { JudgeConfigSchema, type JudgeConfig } from "../eval-harness.js";
import { canonicalJson } from "../eval-store.js";
import { registrySha } from "../material-map.js";
import { loadProfiles, loadStructures, profileFor } from "../profile-load.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import { loadSpeechBands } from "../speech-bands.js";
import { loadStylePacks, stylePackCss, stylePackFor, stylePackSha } from "../style-pack-load.js";
import type { StylePack } from "../style-pack-schema.js";
import { SIDECAR_STATUSES } from "../video-sidecar.js";
import { sha256, type ArtifactStore } from "./artifacts.js";
import { resolveConfig } from "../resolve-stage.js";
import { loadQaGate, QaInspectSchema } from "../qa/gate-profile.js";
import { defaultRenderWorkers } from "../render/render-video.js";
import { timingProfile, TimingProfileSchema } from "../qa/timing-gates.js";
import { auditionConfig, profileRef } from "./audition-stage.js";
import { GatherRequestSchema, type GatherRequest } from "./run-gather.js";
import type { BridgeFile } from "./bridge.js";
import { CACHED_STAGES, type CachedStage, type StageName } from "./records.js";

/**
 * Bumped when a stage's body changes what it makes from the same inputs, so an old cache entry is never read as
 * this body's output. It is also the child workflow's registered version.
 */
export const STAGE_VERSIONS: Record<CachedStage, string> = {
  gather: "g2",
  audition: "pp10",
  script: "x23",
  rewrite: "x13",
  eval: "x13",
  resolve: "p5c2s2f2s2d5",
  tts: "p6d",
  render: "m10c10",
  qa: "x10y",
  sheets: "x10",
};

/** The artifacts each stage reads. */
const STAGE_INPUTS: Record<CachedStage, readonly string[]> = {
  gather: [], audition: ["facts"], script: ["spine", "facts"], rewrite: ["draft"], eval: ["script", "spine"], resolve: ["script"], tts: ["script", "resolved"],
  render: ["script", "resolved", "words", "audio"], qa: ["mp4", "timeline", "words", "script", "resolved", "page"], sheets: ["mp4", "script"],
};

/** Artifacts a stage reads when a pin or an earlier stage supplies them; absent, they stay out of its key. */
const OPTIONAL_INPUTS: Partial<Record<CachedStage, readonly string[]>> = {
  script: ["coverage", "seed-draft"], rewrite: ["facts", "coverage"], eval: ["facts", "coverage"], resolve: ["code", "slots", "layout", "chapter-links", "facts", "custom-layers"],
  render: ["code", "slots", "generated-slots", "custom-layers"], qa: ["visual", "code", "slots", "vtt"], sheets: ["render-manifest", "resolved", "slots", "qa", "visual"],
};

/** A stage variant file: settings for one stage, whose content hash goes into the stage key. */
export const VariantSchema = z.object({
  schema: z.literal("explainer.variant/v1"),
  stage: z.enum(CACHED_STAGES),
  name: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type Variant = z.infer<typeof VariantSchema>;

type VariantShas = Partial<Record<StageName, string>>;

/** Each variant file is stored as an artifact, so the plan (and the stage key) holds its sha, not a path. */
export function storeVariants(request: { variants?: VariantShas; variantShas?: VariantShas }, store: ArtifactStore): VariantShas {
  const stored: VariantShas = { ...request.variantShas };
  for (const [stage, file] of Object.entries(request.variants ?? {})) {
    const variant = VariantSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (variant.stage !== stage) throw new Error(`variant file ${path.basename(file)} is for stage ${variant.stage}, not ${stage}`);
    stored[stage as StageName] = store.putText(readFileSync(file, "utf8"), "variant", { runId: "input", stage: "variant" });
  }
  return stored;
}

const ScriptParamsSchema = z.strictObject({ model: z.string().min(1).optional() });
const RewriteParamsSchema = z.strictObject({ model: z.string().min(1).optional(), rounds: z.number().int().min(1).max(MAX_REWRITE_ROUNDS).optional() });
const TtsParamsSchema = z.strictObject({ voice: z.string().min(1).optional(), rate: z.number().min(0.5).max(2).optional() });
const SheetsParamsSchema = z.strictObject({ take: z.string().min(1).optional(), status: z.enum(SIDECAR_STATUSES).optional() });
const RenderParamsSchema = z.strictObject({ workers: z.number().int().positive().optional(), twoRun: z.boolean().optional(), noQa: z.boolean().optional() });

/** A video and every run of it, oldest first: the sidecar lists them, so a new linked run re-keys the sheets stage. */
export const VideoRefSchema = z.object({ id: z.string(), runIds: z.array(z.string()) });
export type VideoRef = z.infer<typeof VideoRefSchema>;

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
  /** The tts stage's voice band: the profile's, with a tts variant's `voice` and `rate` over it. */
  voice: z.object({ id: z.string(), rate: z.number(), source: z.string() }).optional(),
  /** The tts stage's words a minute per speech band, from doctrine `speech-bands.yaml`, so a band edit re-voices. */
  rates: z.record(z.enum(SPEECH_BANDS), z.number()).optional(),
  /** The render variant's style pack, by content hash, so an edit to the pack's file misses the cache. */
  stylePack: z.object({ id: z.string(), sha: z.string() }).optional(),
  /** The sheets stage's sidecar take and status, the theater stem its poster is named after, and the structure registry by hash. */
  sheets: z.object({ take: z.string(), status: z.enum(SIDECAR_STATUSES), stem: z.string(), structures: z.string() }).optional(),
  video: VideoRefSchema.optional(),
  /** The qa stage's gate profile for the run's type, by content hash, whether it sweeps at 2 Hz, and the type's timing thresholds. */
  qa: z.object({ sha: z.string(), gate: z.array(z.string()), inspect: QaInspectSchema, sweep: z.boolean().optional(), timing: TimingProfileSchema.optional() }).optional(),
  /** The render's capture workers, its two-run and no-QA switches, the pre-capture gate profile and the style pack's CSS. */
  render: z.object({
    workers: z.number().int().positive(), twoRun: z.boolean(), noQa: z.boolean(),
    gate: z.object({ sha: z.string(), gate: z.array(z.string()), inspect: QaInspectSchema }), styleCss: z.string().optional(),
  }).optional(),
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
  /** The video the run makes and its runs; read only when the sheets stage's spec is built. */
  video?: () => VideoRef;
}

/** `sha(stage, definition version, config with the variant, the inputs the stage reads, sample)`: never the outputs, which TTS does not reproduce byte for byte. */
export function stageKey(spec: Omit<StageSpec, "key" | "remainingUsd">): string {
  return sha256(canonicalJson({ stage: spec.stage, version: STAGE_VERSIONS[spec.stage], config: spec.config, inputs: spec.inputs, sample: spec.sample }));
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

function sheetsConfig(settings: RunSettings, params: z.infer<typeof SheetsParamsSchema>, bridge: () => BridgeFile): StageConfig {
  const sheets = { take: params.take ?? "v1", status: params.status ?? "review", stem: bridge().theater.stem, structures: registrySha(loadStructures()) };
  return { sheets, ...(settings.profile ? { profile: profileRef(settings.profile) } : {}), ...(settings.video ? { video: settings.video() } : {}) };
}

/** The gate profile and the type's pacing are read when the spec is built, so an edit to either or to the run's type re-keys qa; `sweep: false` keeps the cue moments only. */
function qaConfig(settings: RunSettings, params: Variant["params"]): StageConfig {
  const { sweep = true } = z.strictObject({ sweep: z.boolean().optional() }).parse(params);
  const timing = timingProfile(settings.profile ? profileFor(loadProfiles(), settings.profile) : undefined);
  return { qa: { ...loadQaGate(settings.profile), sweep, timing }, ...(settings.profile ? { profile: profileRef(settings.profile) } : {}) };
}

/** Render gates on the same profile qa reads, so an edit to it re-keys render too; a host's worker count is part of the key. */
function renderConfig(settings: RunSettings, params: Variant["params"]): StageConfig {
  const p = RenderParamsSchema.parse(params);
  const render = { workers: p.workers ?? defaultRenderWorkers(), twoRun: p.twoRun ?? false, noQa: p.noQa ?? false, gate: loadQaGate(settings.profile) };
  return { render, ...(settings.profile ? { profile: profileRef(settings.profile) } : {}) };
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
  if (stage === "sheets") return sheetsConfig(settings, SheetsParamsSchema.parse(params), bridge);
  if (stage === "qa") return qaConfig(settings, params);
  return renderConfig(settings, params);
}

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
  css: string;
}

/** The render variant param that picks a style pack (plan §A.2): the pack is a render setting, never a TTS one. */
export const STYLE_PACK_PARAM = "stylePack";

/** Lifts the style pack out of a render variant's params: its CSS goes to the page and its content hash into the config. */
function styleConfig(stage: CachedStage, params: Variant["params"], packs: () => ReadonlyMap<string, StylePack>): { params: Variant["params"]; style?: StyleChoice } {
  const { [STYLE_PACK_PARAM]: id, ...rest } = params;
  if (id === undefined) return { params };
  if (stage !== "render") throw new Error(`variant for ${stage} sets ${STYLE_PACK_PARAM}, which only a render variant may set`);
  const pack = stylePackFor(packs(), String(id));
  return { params: rest, style: { stylePack: { id: pack.id, sha: stylePackSha(pack) }, css: stylePackCss(pack) } };
}

/** Builds a stage's spec and key from what it reads; a missing input fails here, before any child run starts. */
export function stageSpec(request: SpecRequest): StageSpec {
  const { stage, variant } = request;
  if (variant && variant.value.stage !== stage) throw new Error(`variant "${variant.value.name}" is for stage ${variant.value.stage}, not ${stage}`);
  const inputs: Record<string, string> = {};
  for (const name of STAGE_INPUTS[stage]) {
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
    ...(style && settings.render ? { stylePack: style.stylePack, render: { ...settings.render, styleCss: style.css } } : {}),
    ...(stage === "resolve" && request.builder ? { builder: request.builder } : {}),
  };
  const keyed = { stage, inputs, config, sample: request.sample };
  return { ...keyed, key: stageKey(keyed), remainingUsd: request.remainingUsd };
}
