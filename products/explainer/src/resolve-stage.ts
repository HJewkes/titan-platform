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
import { SIM_BEAT, SimTracesSchema, runSimPass, shippedSims, type SimRegistry } from "./sim/sim-resolve.js";
import { slotOverrideProblems, withSlotOverrides } from "./slot-overrides.js";
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

type CutBeat = z.infer<typeof CutBeatSchema>;

/**
 * Sweeps and checks each sim beat, storing its frozen trace and the `sim-traces` artifact, and cuts every beat whose
 * sim fails: before tts, so a cut beat is never voiced.
 */
function cutFailingSims(script: ScriptV1, beats: Resolved["beats"], input: ModelStageInput, sims: SimRegistry, read: (name: string) => string | undefined) {
  const simIds = new Set(beats.filter((beat) => beat.beat === SIM_BEAT).map((beat) => beat.id));
  if (simIds.size === 0) return { kept: beats, cut: [] as CutBeat[], notes: [] as string[], simTraces: undefined as string | undefined };
  const slots = read("slots");
  const pass = runSimPass({
    beats: script.beats.filter((beat) => simIds.has(beat.id)),
    slots: slots === undefined ? undefined : z.record(z.string(), z.unknown()).parse(JSON.parse(slots)),
    facts: read("facts"),
    registry: sims,
    putTrace: (json) => input.store.putText(json, "sim-trace", input.from),
  });
  const failed = new Map(pass.traces.verdicts.filter((verdict) => !verdict.pass).map((verdict) => [verdict.beat, verdict]));
  const cut = beats.flatMap((beat): CutBeat[] => {
    const verdict = failed.get(beat.id);
    return verdict ? [{ id: beat.id, chapter: beat.chapter, code: verdict.code ?? "E-SIM-MISS", detail: verdict.detail }] : [];
  });
  const unslottedNote = `sim beats ${pass.unslotted.join(", ")} have no sim slots at resolve: not swept or checked`;
  const notes = [...cut.map((beat) => `sim beat ${beat.id} cut (${beat.code}): ${beat.detail}`), ...(pass.unslotted.length ? [unslottedNote] : [])];
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
  const keptIds = new Set(beats.map((beat) => beat.id));
  const { rows, unplaced } = scriptBudgets({ ...script, beats: script.beats.filter((beat) => keptIds.has(beat.id)) }, beats, loadBeatSpecs());
  const resolved: Resolved = { schema: "explainer.resolved/v1", profile: script.profile, beats, budgets: rows, ...(cut.length ? { cut } : {}) };
  const sha = store.putText(`${JSON.stringify(resolved, null, 2)}\n`, "resolved", input.from);
  const rowsUsed = [...new Set(beats.map((beat) => beat.row))];
  const unplacedNote = `no block cap for chapters ${unplaced.join(", ")}: no block of ${script.profile} has that id`;
  const unlinkedNote = `no chapter link for companion-link beats ${linked.unlinked.join(", ")}: the chapter-links artifact lacks their chapters`;
  const notes = [`${beats.length} beats resolved by rows ${rowsUsed.join(", ")}`, ...(unplaced.length ? [unplacedNote] : []), ...(linked.unlinked.length ? [unlinkedNote] : []), ...simNotes];
  return { outputs: { resolved: sha, ...(simTraces ? { "sim-traces": simTraces } : {}) }, notes };
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
  const filled = z.record(z.string(), z.unknown()).parse(readJson(input, "slots"));
  const visuals = new Map(script.beats.map(({ id, visual }) => [id, visual]));
  const slots = Object.fromEntries(Object.entries(filled).map(([id, value]) => [id, withSlotOverrides(visuals.get(id) ?? {}, value)]));
  const layout = input.artifacts.layout === undefined ? undefined : LayoutSchema.parse(readJson(input, "layout"));
  return { beats, specs: loadBeatSpecs(), slots, ...(layout ? { layout } : {}) };
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
