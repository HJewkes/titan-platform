import { z } from "zod";
import { loadBeatSpecs, parseBeatSlots } from "./beat-load.js";
import { COMPONENT_MATURITIES, SPEECH_BANDS, type BeatSpec } from "./beat-schema.js";
import type { EmphasisGateInput } from "./emphasis-gate.js";
import { canonicalJson } from "./eval-store.js";
import { ChapterLinksSchema, companionLinkSlots } from "./presets/repo-explainer/companion.js";
import { loadProfiles } from "./profile-load.js";
import { ResolveError, resolveBeats, type ResolvedBeat } from "./resolve-beat.js";
import { budgetVerdict, scriptBudgets } from "./resolve-budget.js";
import { citationRefusals, codeSource } from "./resolve-citation.js";
import { CONTENT_SHAPES, RESOLVE_ROWS, type ResolveRow } from "./resolve-tables.js";
import { BEAT_FUNCTIONS, FRAMINGS, ScriptSchema, VISUAL_LAYERS, type ScriptV1 } from "./script-schema.js";
import { slotOverrideProblems, withSlotOverrides } from "./slot-overrides.js";
import { loadSpeechBands } from "./speech-bands.js";
import { FillError, fillScript, type FilledScript } from "./template-fill/fill.js";
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
  /** Slots resolve fills itself, before template fill writes the rest: a `companion-link` card's link. */
  slots: z.record(z.string(), z.string()).optional(),
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

/** Code citations first, then the tables; any refusal throws before the stage stores an artifact. */
function resolveScript(script: ScriptV1, code: string | undefined, specs: ReadonlyMap<string, BeatSpec>): ResolvedBeat[] {
  const refused = citationRefusals(script.beats, code === undefined ? undefined : codeSource(code));
  if (refused.length > 0) throw new ResolveError(refused);
  return resolveBeats(script.beats, specs, shippedVisualRouter());
}

const COMPANION_LINK = "companion-link";

/** Fills each `companion-link` card from the run's chapter links, so it opens its chapter's section of the companion doc. */
function linkCompanionCards(beats: readonly ResolvedBeat[], chapterLinks: string | undefined): { beats: Resolved["beats"]; unlinked: string[] } {
  if (chapterLinks === undefined) return { beats: [...beats], unlinked: [] };
  const links = ChapterLinksSchema.parse(JSON.parse(chapterLinks));
  const unlinked: string[] = [];
  const linked = beats.map((beat) => {
    const slots = beat.beat === COMPANION_LINK ? companionLinkSlots(links, beat.chapter) : undefined;
    if (beat.beat === COMPANION_LINK && slots === undefined) unlinked.push(beat.id);
    return slots === undefined ? beat : { ...beat, slots: { ...slots } };
  });
  return { beats: linked, unlinked };
}

/** The template fill over the resolved beats, with the run's cited code; a refusal is returned for the gate to name. */
function templateFill(script: ScriptV1, beats: Resolved["beats"], code: string | undefined): FilledScript | FillError {
  try {
    return fillScript(script, { beats }, { specs: loadBeatSpecs(), ...(code === undefined ? {} : { code: codeSource(code) }) });
  } catch (error) {
    if (error instanceof FillError) return error;
    throw error;
  }
}

/**
 * Each template beat's generated slots by beat id, before the owner's overrides, which the emphasis-target gate lays
 * on. A refused fill gives none, so the template-fill gate, not the body, names the refused beats.
 */
function generatedSlots(script: ScriptV1, beats: Resolved["beats"], code: string | undefined): string | undefined {
  const filled = templateFill(script, beats, code);
  if (filled instanceof FillError) return undefined;
  return `${JSON.stringify(Object.fromEntries(filled.beats.map((beat) => [beat.id, beat.generated])), null, 2)}\n`;
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
  const read = (name: string): string | undefined => {
    const sha = artifacts[name];
    return sha === undefined ? undefined : store.readText(sha);
  };
  const { beats, unlinked } = linkCompanionCards(resolveScript(script, read("code"), specs), read("chapter-links"));
  const { rows, unplaced } = scriptBudgets(script, beats, specs);
  const resolved: Resolved = { schema: "explainer.resolved/v1", profile: script.profile, beats, budgets: rows };
  const sha = store.putText(`${JSON.stringify(resolved, null, 2)}\n`, "resolved", input.from);
  const slots = artifacts.slots === undefined ? generatedSlots(script, beats, read("code")) : undefined;
  const rowsUsed = [...new Set(beats.map((beat) => beat.row))];
  const unplacedNote = `no block cap for chapters ${unplaced.join(", ")}: no block of ${script.profile} has that id`;
  const unlinkedNote = `no chapter link for companion-link beats ${unlinked.join(", ")}: the chapter-links artifact lacks their chapters`;
  const notes = [`${beats.length} beats resolved by rows ${rowsUsed.join(", ")}`, ...(unplaced.length ? [unplacedNote] : []), ...(unlinked.length ? [unlinkedNote] : [])];
  return { outputs: { resolved: sha, ...(slots === undefined ? {} : { slots: store.putText(slots, "slots", input.from) }) }, notes };
}

const readJson = (input: CheckInput, name: string): unknown => JSON.parse(input.store.readText(input.artifacts[name]!));

const BoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const LayoutSchema = z.object({ stage: z.object({ width: z.number(), height: z.number() }), boxes: z.record(z.string(), z.record(z.string(), BoxSchema)) });

const readCode = (input: CheckInput): string | undefined => (input.artifacts.code === undefined ? undefined : input.store.readText(input.artifacts.code));

const parses = (specs: ReadonlyMap<string, BeatSpec>, type: string, slots: unknown): boolean => {
  try {
    parseBeatSlots(specs, type, slots);
    return true;
  } catch {
    return false;
  }
};

/**
 * The spec each beat's slots were filled for: the resolver's choice, unless they do not parse under it and the
 * template fill fell back, as it does for slots resolve stored. A pin valid for the chosen spec keeps that spec.
 */
function filledSpecs(script: ScriptV1, resolved: Resolved["beats"], slots: Readonly<Record<string, unknown>>, code: string | undefined): Map<string, string> {
  const chosen = new Map(resolved.map((beat) => [beat.id, beat.beat]));
  const filled = templateFill(script, resolved, code);
  if (filled instanceof FillError) return chosen;
  const specs = loadBeatSpecs();
  for (const beat of filled.beats) {
    if (beat.fallback !== undefined && !parses(specs, beat.fallback.from, slots[beat.id])) chosen.set(beat.id, beat.spec);
  }
  return chosen;
}

/**
 * What the emphasis-target gate reads at resolve: the script's cues on the beat specs their slots were filled for, the
 * template fill's slots by beat id, and the element boxes once a `layout` artifact exists.
 */
export function readEmphasisInput(input: CheckInput): EmphasisGateInput {
  const script = ScriptSchema.parse(readJson(input, "script"));
  const filled = z.record(z.string(), z.unknown()).parse(readJson(input, "slots"));
  const visuals = new Map(script.beats.map(({ id, visual }) => [id, visual]));
  const slots = Object.fromEntries(Object.entries(filled).map(([id, value]) => [id, withSlotOverrides(visuals.get(id) ?? {}, value)]));
  const chosen = filledSpecs(script, ResolvedSchema.parse(readJson(input, "resolved")).beats, slots, readCode(input));
  const beats = script.beats.map(({ id, visual }) => ({ id, visual: { ...visual, beat: chosen.get(id) ?? visual.beat } }));
  const layout = input.artifacts.layout === undefined ? undefined : LayoutSchema.parse(readJson(input, "layout"));
  return { beats, specs: loadBeatSpecs(), slots, ...(layout ? { layout } : {}) };
}

const fallbackLine = (beat: FilledScript["beats"][number]): string => `${beat.id} ${beat.fallback!.from} → ${beat.spec} (${beat.fallback!.reason})`;

/**
 * The `template-fill` gate: every template beat of the script fills its chosen spec's slots, or a fallback's. A
 * fallback passes and is named in the detail; a refused beat fails the stage.
 */
export function templateFillVerdict(input: CheckInput): { pass: boolean; detail: string } {
  const script = ScriptSchema.parse(readJson(input, "script"));
  const { beats } = ResolvedSchema.parse(readJson(input, "resolved"));
  const filled = templateFill(script, beats, readCode(input));
  if (filled instanceof FillError) return { pass: false, detail: filled.message };
  const fallbacks = filled.beats.filter((beat) => beat.fallback !== undefined).map(fallbackLine);
  const shown = fallbacks.slice(0, 5).join("; ") + (fallbacks.length > 5 ? ` and ${fallbacks.length - 5} more` : "");
  return { pass: true, detail: `${filled.beats.length} beats filled, ${fallbacks.length} by fallback${fallbacks.length ? `: ${shown}` : ""}` };
}

export const wordBudgetVerdict = (input: CheckInput): { pass: boolean; detail: string } => budgetVerdict(ResolvedSchema.parse(readJson(input, "resolved")).budgets);

/** The `slot-overrides` gate: every owner override in the script is one the beat spec the resolver chose accepts. */
export function slotOverridesVerdict(input: CheckInput): { pass: boolean; detail: string } {
  const script = ScriptSchema.parse(readJson(input, "script"));
  const problems = slotOverrideProblems(script.beats, ResolvedSchema.parse(readJson(input, "resolved")).beats, loadBeatSpecs());
  const overridden = script.beats.filter(({ visual }) => visual.slots !== undefined || visual.tune !== undefined).length;
  const shown = problems.slice(0, 5).join("; ") + (problems.length > 5 ? ` and ${problems.length - 5} more` : "");
  return { pass: problems.length === 0, detail: problems.length === 0 ? `${overridden} beats carry overrides, all accepted` : `refused overrides: ${shown}` };
}
