import { z } from "zod";
import { loadBeatSpecs } from "./beat-load.js";
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
import { loadSims } from "./sim/sim-load.js";
import { SIM_BEAT, SimTracesSchema, runSimPass, shippedSims, type SimRegistry, type SimSlotsFill } from "./sim/sim-resolve.js";
import { slotOverrideProblems } from "./slot-overrides.js";
import { loadSpeechBands } from "./speech-bands.js";
import { FillError, fillBeat, fillScript, type FillContext, type FilledBeat, type FilledScript, type FillRefusal } from "./template-fill/fill.js";
import { beatScope } from "./template-fill/scope.js";
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

const CutBeatSchema = z.object({ id: z.string(), chapter: z.string(), code: z.string(), detail: z.string() });

const BudgetRowSchema = z.object({ scope: z.enum(["beat", "block"]), id: z.string(), words: z.number(), seconds: z.number(), wordsPerS: z.number(), cap: z.number() });

/** The `resolved` artifact: each beat's component, framing, layer and anchors, and every word budget it was held to. */
export const ResolvedSchema = z.object({
  schema: z.literal("explainer.resolved/v1"),
  profile: z.string(),
  beats: z.array(ResolvedBeatSchema),
  budgets: z.array(BudgetRowSchema),
  /** Sim beats cut because their sim did not reproduce their claim; tts voices none of them. */
  cut: z.array(CutBeatSchema).optional(),
});
type Resolved = z.infer<typeof ResolvedSchema>;

/** The script beats resolve kept: every beat but those `resolved.cut` lists, the set each resolve consumer reads. */
export function keptBeats<T extends { id: string }>(beats: readonly T[], resolved: Pick<Resolved, "cut">): T[] {
  const cut = new Set((resolved.cut ?? []).map((beat) => beat.id));
  return beats.filter((beat) => !cut.has(beat.id));
}

/**
 * The doctrine the resolve stage reads, by content hash: beat specs, profiles, the pinned router, the speech bands' caps,
 * the resolver rows and the sim registry, so a tolerance change re-keys the stage.
 */
export function resolveConfig(rows: readonly ResolveRow[] = RESOLVE_ROWS, sims: SimRegistry["specs"] = loadSims()): { doctrine: string } {
  const sorted = <T>(map: ReadonlyMap<string, T>): T[] => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  const doctrine = { beats: sorted(loadBeatSpecs()), profiles: sorted(loadProfiles().profiles), router: shippedVisualRouter(), bands: loadSpeechBands(), rows, sims: sorted(sims) };
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

type Pin = Readonly<Record<string, unknown>> | undefined;

const parsePin = (text: string | undefined): Pin => (text === undefined ? undefined : z.record(z.string(), z.unknown()).parse(JSON.parse(text)));

/**
 * The template fill over the kept beats, with the run's cited code and the owner's `slots` pin, the same inputs the
 * render fills from; a refusal is returned for the gate to name.
 */
const fillContext = (code: string | undefined, pinned: Pin): FillContext => ({
  specs: loadBeatSpecs(),
  ...(code === undefined ? {} : { code: codeSource(code) }),
  ...(pinned === undefined ? {} : { pinned }),
});

function templateFill(script: ScriptV1, resolved: Pick<Resolved, "beats" | "cut">, code: string | undefined, pinned: Pin): FilledScript | FillError {
  try {
    return fillScript({ ...script, beats: keptBeats(script.beats, resolved) }, resolved, fillContext(code, pinned));
  } catch (error) {
    if (error instanceof FillError) return error;
    throw error;
  }
}

/**
 * Each template beat's generated slots by beat id, before the owner's overrides. Stored as `generated-slots`, never
 * `slots`: a later run that carries it forward must not read it as a pin. A refused fill gives none, so the
 * template-fill gate, not the body, names the refused beats.
 */
function generatedSlots(filled: FilledScript | FillError): string | undefined {
  if (filled instanceof FillError) return undefined;
  return `${JSON.stringify(Object.fromEntries(filled.beats.map((beat) => [beat.id, beat.generated])), null, 2)}\n`;
}

type CutBeat = z.infer<typeof CutBeatSchema>;

const simSlotsFill = (found: FilledBeat | FillRefusal): SimSlotsFill => {
  if ("detail" in found) return { problem: found.detail };
  return found.fallback === undefined ? { slots: found.slots } : { problem: `the fill fell back to ${found.spec}: ${found.fallback.reason}` };
};

/**
 * Each sim beat's slots as the template fill draws them: the pin's entry (else the generated layer), then the owner's
 * overrides. The whole-script fill needs the cut list the sims decide, so the sim beats are filled alone first; a sim
 * opens no chapter stage and continues none, so alone each fills as it does in the whole script.
 */
function simSlotsByFill(script: ScriptV1, simBeats: Resolved["beats"], read: (name: string) => string | undefined): Map<string, SimSlotsFill> {
  const context = fillContext(read("code"), parsePin(read("slots")));
  const rows = new Map(simBeats.map((row) => [row.id, row]));
  const beats = script.beats.filter((beat) => rows.has(beat.id));
  return new Map(beats.map((beat) => [beat.id, simSlotsFill(fillBeat(beat, rows.get(beat.id)!, beatScope(script, beat, context.code), context))]));
}

/**
 * Sweeps and checks each sim beat, storing its frozen trace and the `sim-traces` artifact, and cuts every beat whose
 * sim fails or has no slots to sweep: before tts, so a cut beat is never voiced.
 */
function cutFailingSims(script: ScriptV1, beats: Resolved["beats"], input: ModelStageInput, sims: SimRegistry, read: (name: string) => string | undefined) {
  const simBeats = beats.filter((beat) => beat.beat === SIM_BEAT);
  if (simBeats.length === 0) return { kept: beats, cut: [] as CutBeat[], notes: [] as string[], simTraces: undefined as string | undefined };
  const filled = simSlotsByFill(script, simBeats, read);
  const pass = runSimPass({
    beats: script.beats.filter((beat) => filled.has(beat.id)),
    filled,
    facts: read("facts"),
    registry: sims,
    putTrace: (json) => input.store.putText(json, "sim-trace", input.from),
  });
  const failed = new Map(pass.traces.verdicts.filter((verdict) => !verdict.pass).map((verdict) => [verdict.beat, verdict]));
  const cut = beats.flatMap((beat): CutBeat[] => {
    const verdict = failed.get(beat.id);
    return verdict ? [{ id: beat.id, chapter: beat.chapter, code: verdict.code ?? "E-SIM-MISS", detail: verdict.detail }] : [];
  });
  const notes = cut.map((beat) => `sim beat ${beat.id} cut (${beat.code}): ${beat.detail}`);
  const simTraces = input.store.putText(`${JSON.stringify(pass.traces, null, 2)}\n`, "sim-traces", input.from);
  return { kept: beats.filter((beat) => !failed.has(beat.id)), cut, notes, simTraces };
}

function readScript(input: ModelStageInput): ScriptV1 {
  if (input.artifacts.script === undefined) throw new Error(`stage resolve needs artifact "script", which no earlier stage produced`);
  return ScriptSchema.parse(JSON.parse(input.store.readText(input.artifacts.script)));
}

/**
 * The `explainer.resolve` body (workflow plan §2.3 stage 6, PP-6): every beat of the script through the resolver
 * tables, each sim beat checked against its claim, and the word budgets of the beats kept. The spec's config pins the
 * doctrine it was keyed on; other doctrine refuses.
 */
export function runResolveStage(input: ModelStageInput, config: { doctrine: string }, sims: SimRegistry = shippedSims()): StageOutcome {
  if (resolveConfig(RESOLVE_ROWS, sims.specs).doctrine !== config.doctrine) throw new Error("resolve: the beat specs, profiles, router or sims changed since this stage was keyed; build a new spec");
  const { artifacts, store } = input;
  const script = readScript(input);
  const read = (name: string): string | undefined => (artifacts[name] === undefined ? undefined : store.readText(artifacts[name]));
  const linked = linkCompanionCards(resolveScript(script, read("code"), loadBeatSpecs()), read("chapter-links"));
  const { kept: beats, cut, notes: simNotes, simTraces } = cutFailingSims(script, linked.beats, input, sims, read);
  const { rows, unplaced } = scriptBudgets({ ...script, beats: keptBeats(script.beats, { cut }) }, beats, loadBeatSpecs());
  const resolved: Resolved = { schema: "explainer.resolved/v1", profile: script.profile, beats, budgets: rows, ...(cut.length ? { cut } : {}) };
  const sha = store.putText(`${JSON.stringify(resolved, null, 2)}\n`, "resolved", input.from);
  const generated = generatedSlots(templateFill(script, resolved, read("code"), parsePin(read("slots"))));
  const rowsUsed = [...new Set(beats.map((beat) => beat.row))];
  const unplacedNote = `no block cap for chapters ${unplaced.join(", ")}: no block of ${script.profile} has that id`;
  const unlinkedNote = `no chapter link for companion-link beats ${linked.unlinked.join(", ")}: the chapter-links artifact lacks their chapters`;
  const notes = [`${beats.length} beats resolved by rows ${rowsUsed.join(", ")}`, ...(unplaced.length ? [unplacedNote] : []), ...(linked.unlinked.length ? [unlinkedNote] : []), ...simNotes];
  const fill: Record<string, string> = generated === undefined ? {} : { "generated-slots": store.putText(generated, "generated-slots", input.from) };
  const outputs = { resolved: sha, ...(simTraces ? { "sim-traces": simTraces } : {}), ...fill };
  return { outputs, notes };
}

const readJson = (input: CheckInput, name: string): unknown => JSON.parse(input.store.readText(input.artifacts[name]!));

const BoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const LayoutSchema = z.object({ stage: z.object({ width: z.number(), height: z.number() }), boxes: z.record(z.string(), z.record(z.string(), BoxSchema)) });

const readCode = (input: CheckInput): string | undefined => (input.artifacts.code === undefined ? undefined : input.store.readText(input.artifacts.code));

/** The fill the gates read: the one the body ran, recomputed from the script, resolved beats, code and `slots` pin. */
function fillAtResolve(input: CheckInput): FilledScript | FillError {
  const script = ScriptSchema.parse(readJson(input, "script"));
  const pinned = input.artifacts.slots === undefined ? undefined : parsePin(input.store.readText(input.artifacts.slots));
  return templateFill(script, ResolvedSchema.parse(readJson(input, "resolved")), readCode(input), pinned);
}

/**
 * What the emphasis-target gate reads at resolve: the script's cues on the beat specs the template fill drew, a
 * fallback's included, the filled slots with the owner's overrides laid on, and the element boxes once a `layout`
 * artifact exists. A refused fill throws, failing the gate beside the template-fill gate that names the beats.
 */
export function readEmphasisInput(input: CheckInput): EmphasisGateInput {
  const filled = fillAtResolve(input);
  if (filled instanceof FillError) throw new Error("the template fill refused; the template-fill gate names the beats");
  const script = ScriptSchema.parse(readJson(input, "script"));
  const resolved = ResolvedSchema.parse(readJson(input, "resolved"));
  const drawn = new Map(filled.beats.map((beat) => [beat.id, beat.spec]));
  const chosen = new Map(resolved.beats.map((beat) => [beat.id, beat.beat]));
  const beats = keptBeats(script.beats, resolved).map(({ id, visual }) => ({ id, visual: { ...visual, beat: drawn.get(id) ?? chosen.get(id) ?? visual.beat } }));
  const slots = Object.fromEntries(filled.beats.map((beat) => [beat.id, beat.slots]));
  const layout = input.artifacts.layout === undefined ? undefined : LayoutSchema.parse(readJson(input, "layout"));
  return { beats, specs: loadBeatSpecs(), slots, ...(layout ? { layout } : {}) };
}

const fallbackLine = (beat: FilledScript["beats"][number]): string => `${beat.id} ${beat.fallback!.from} → ${beat.spec} (${beat.fallback!.reason})`;

/**
 * The `template-fill` gate: every template beat of the script fills its chosen spec's slots, or a fallback's. A
 * fallback passes and is named in the detail; a refused beat fails the stage.
 */
export function templateFillVerdict(input: CheckInput): { pass: boolean; detail: string } {
  const filled = fillAtResolve(input);
  if (filled instanceof FillError) return { pass: false, detail: filled.message };
  const fallbacks = filled.beats.filter((beat) => beat.fallback !== undefined).map(fallbackLine);
  const shown = fallbacks.slice(0, 5).join("; ") + (fallbacks.length > 5 ? ` and ${fallbacks.length - 5} more` : "");
  return { pass: true, detail: `${filled.beats.length} beats filled, ${fallbacks.length} by fallback${fallbacks.length ? `: ${shown}` : ""}` };
}

export const wordBudgetVerdict = (input: CheckInput): { pass: boolean; detail: string } => budgetVerdict(ResolvedSchema.parse(readJson(input, "resolved")).budgets);

/** The `slot-overrides` gate: every owner override on a kept beat is one the beat spec the resolver chose accepts. */
export function slotOverridesVerdict(input: CheckInput): { pass: boolean; detail: string } {
  const resolved = ResolvedSchema.parse(readJson(input, "resolved"));
  const beats = keptBeats(ScriptSchema.parse(readJson(input, "script")).beats, resolved);
  const problems = slotOverrideProblems(beats, resolved.beats, loadBeatSpecs());
  const overridden = beats.filter(({ visual }) => visual.slots !== undefined || visual.tune !== undefined).length;
  const shown = problems.slice(0, 5).join("; ") + (problems.length > 5 ? ` and ${problems.length - 5} more` : "");
  return { pass: problems.length === 0, detail: problems.length === 0 ? `${overridden} beats carry overrides, all accepted` : `refused overrides: ${shown}` };
}

/** The `sim-check` report: which sim beats passed, and which were cut and why. */
export function simCheckVerdict(input: CheckInput): { pass: boolean; detail: string } {
  const { verdicts } = SimTracesSchema.parse(readJson(input, "sim-traces"));
  const failed = verdicts.filter((verdict) => !verdict.pass);
  const shown = failed.slice(0, 5).map((verdict) => `${verdict.beat} (${verdict.code})`).join(", ") + (failed.length > 5 ? ` and ${failed.length - 5} more` : "");
  return { pass: failed.length === 0, detail: failed.length === 0 ? `${verdicts.length} sim beats pass` : `${verdicts.length - failed.length} of ${verdicts.length} sim beats pass; cut: ${shown}` };
}

/** The `sim-cut-orphan` gate: no sim cut leaves a chapter with no beats, since then the script must change, not just lose a beat. */
export function simCutOrphanVerdict(input: CheckInput): { pass: boolean; detail: string } {
  const script = ScriptSchema.parse(readJson(input, "script"));
  const cutIds = new Set((ResolvedSchema.parse(readJson(input, "resolved")).cut ?? []).map((beat) => beat.id));
  const emptied = script.chapters.map((chapter) => chapter.id).filter((id) => {
    const beats = script.beats.filter((beat) => beat.chapter === id);
    return beats.length > 0 && beats.every((beat) => cutIds.has(beat.id));
  });
  return { pass: emptied.length === 0, detail: emptied.length === 0 ? `${cutIds.size} sim beats cut, no chapter emptied` : `sim cuts empty chapters ${emptied.join(", ")}: rewrite the script` };
}
