import { z } from "zod";
import { loadBeatSpecs } from "./beat-load.js";
import { COMPONENT_MATURITIES, SPEECH_BANDS, type BeatSpec } from "./beat-schema.js";
import type { EmphasisGateInput } from "./emphasis-gate.js";
import { canonicalJson } from "./eval-store.js";
import { loadProfiles, profileFor } from "./profile-load.js";
import { ResolveError, resolveBeats, type ResolvedBeat } from "./resolve-beat.js";
import { beatBudget, blockBudgets, budgetVerdict, type BudgetRow } from "./resolve-budget.js";
import { citationRefusals, codeSource } from "./resolve-citation.js";
import { CONTENT_SHAPES, RESOLVE_ROWS, type ResolveRow } from "./resolve-tables.js";
import { BEAT_FUNCTIONS, FRAMINGS, ScriptSchema, VISUAL_LAYERS, type ScriptV1 } from "./script-schema.js";
import { loadSpeechBands } from "./speech-bands.js";
import { shippedVisualRouter } from "./visual-router.js";
import { sha256 } from "./workflow/artifacts.js";
import type { ModelStageInput } from "./workflow/model-stages.js";
import type { StageOutcome } from "./workflow/records.js";
import type { CheckInput } from "./workflow/stage-checks.js";

const ResolvedBeatSchema = z.object({
  id: z.string(),
  chapter: z.string(),
  key: z.object({ function: z.enum(BEAT_FUNCTIONS), job: z.string(), content: z.enum(CONTENT_SHAPES), route: z.string() }),
  row: z.string(),
  beat: z.string(),
  component: z.object({ name: z.string().optional(), maturity: z.enum(COMPONENT_MATURITIES) }),
  band: z.enum(SPEECH_BANDS),
  framing: z.enum(FRAMINGS),
  layer: z.enum(VISUAL_LAYERS),
  anchors: z.array(z.string()),
});

const BudgetRowSchema = z.object({ scope: z.enum(["beat", "block"]), id: z.string(), words: z.number(), seconds: z.number(), wordsPerS: z.number(), cap: z.number() });

/** The `resolved` artifact: each beat's component, framing, layer and anchors, and every word budget it was held to. */
export const ResolvedSchema = z.object({
  schema: z.literal("explainer.resolved/v1"),
  profile: z.string(),
  beats: z.array(ResolvedBeatSchema),
  budgets: z.array(BudgetRowSchema),
});
type Resolved = z.infer<typeof ResolvedSchema>;

/** The doctrine the resolve stage reads, by content hash: beat specs, profiles, the pinned router, the speech bands' caps and the resolver rows. */
export function resolveConfig(rows: readonly ResolveRow[] = RESOLVE_ROWS): { doctrine: string } {
  const sorted = <T>(map: ReadonlyMap<string, T>): T[] => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  const doctrine = { beats: sorted(loadBeatSpecs()), profiles: sorted(loadProfiles().profiles), router: shippedVisualRouter(), bands: loadSpeechBands(), rows };
  return { doctrine: sha256(canonicalJson(doctrine)) };
}

function budgets(script: ScriptV1, resolved: readonly ResolvedBeat[], specs: ReadonlyMap<string, BeatSpec>): { rows: BudgetRow[]; unplaced: string[] } {
  const bandOf = new Map(resolved.map((beat) => [beat.id, beat.band]));
  const bands = loadSpeechBands();
  const blocks = blockBudgets(script.beats, profileFor(loadProfiles(), script.profile), specs, bands);
  return { rows: [...script.beats.map((beat) => beatBudget(beat, bandOf.get(beat.id)!, bands)), ...blocks.rows], unplaced: blocks.unplaced };
}

/** Code citations first, then the tables; any refusal throws before the stage stores an artifact. */
function resolveScript(script: ScriptV1, code: string | undefined, specs: ReadonlyMap<string, BeatSpec>): ResolvedBeat[] {
  const refused = citationRefusals(script.beats, code === undefined ? undefined : codeSource(code));
  if (refused.length > 0) throw new ResolveError(refused);
  return resolveBeats(script.beats, specs, shippedVisualRouter());
}

/**
 * The `explainer.resolve` body (workflow plan §2.3 stage 6, PP-6): every beat of the script through the resolver
 * tables, with its word budgets. The spec's config pins the doctrine it was keyed on; other doctrine refuses.
 */
export function runResolveStage(input: ModelStageInput, config: { doctrine: string }): StageOutcome {
  if (resolveConfig().doctrine !== config.doctrine) throw new Error("resolve: the beat specs, profiles or router changed since this stage was keyed; build a new spec");
  const { artifacts, store } = input;
  if (artifacts.script === undefined) throw new Error(`stage resolve needs artifact "script", which no earlier stage produced`);
  const script = ScriptSchema.parse(JSON.parse(store.readText(artifacts.script)));
  const specs = loadBeatSpecs();
  const beats = resolveScript(script, artifacts.code === undefined ? undefined : store.readText(artifacts.code), specs);
  const { rows, unplaced } = budgets(script, beats, specs);
  const resolved: Resolved = { schema: "explainer.resolved/v1", profile: script.profile, beats, budgets: rows };
  const sha = store.putText(`${JSON.stringify(resolved, null, 2)}\n`, "resolved", input.from);
  const rowsUsed = [...new Set(beats.map((beat) => beat.row))];
  const unplacedNote = `no block cap for chapters ${unplaced.join(", ")}: no block of ${script.profile} has that id`;
  const notes = [`${beats.length} beats resolved by rows ${rowsUsed.join(", ")}`, ...(unplaced.length ? [unplacedNote] : [])];
  return { outputs: { resolved: sha }, notes };
}

const readJson = (input: CheckInput, name: string): unknown => JSON.parse(input.store.readText(input.artifacts[name]!));

const BoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const LayoutSchema = z.object({ stage: z.object({ width: z.number(), height: z.number() }), boxes: z.record(z.string(), z.record(z.string(), BoxSchema)) });

/**
 * What the emphasis-target gate reads at resolve: the script's cues on the beat specs the resolver chose, the template
 * fill's slots by beat id, and the element boxes once a `layout` artifact exists.
 */
export function readEmphasisInput(input: CheckInput): EmphasisGateInput {
  const script = ScriptSchema.parse(readJson(input, "script"));
  const chosen = new Map(ResolvedSchema.parse(readJson(input, "resolved")).beats.map((beat) => [beat.id, beat.beat]));
  const beats = script.beats.map(({ id, visual }) => ({ id, visual: { ...visual, beat: chosen.get(id) ?? visual.beat } }));
  const slots = z.record(z.string(), z.unknown()).parse(readJson(input, "slots"));
  const layout = input.artifacts.layout === undefined ? undefined : LayoutSchema.parse(readJson(input, "layout"));
  return { beats, specs: loadBeatSpecs(), slots, ...(layout ? { layout } : {}) };
}

export const wordBudgetVerdict = (input: CheckInput): { pass: boolean; detail: string } => budgetVerdict(ResolvedSchema.parse(readJson(input, "resolved")).budgets);
