import { emphasisTargets, loadBeatSpecs } from "./beat-load.js";
import type { BeatSpec } from "./beat-schema.js";
import { emphasisTargetGate, type EmphasisFailure } from "./emphasis-gate.js";
import type { L0Result } from "./eval-l0.js";
import { resolveBeat, type ResolvedBeat } from "./resolve-beat.js";
import type { ScriptV1 } from "./script-schema.js";
import { SIM_BEAT } from "./sim/sim-resolve.js";
import { FillError, fillScript, type FilledBeat, type FilledScript } from "./template-fill/fill.js";
import { shippedVisualRouter } from "./visual-router.js";

export const TEMPLATE_FILL_ID = "template-fill";

/**
 * Refs whose slots come from run artifacts the script stage does not hold: cited code for the code beats, the
 * chapter links for a companion card. Resolve fills them with those artifacts, so the draft's fill skips them.
 */
const RUN_FILLED_REFS: ReadonlySet<string> = new Set(["code-walk", "docs-vs-code", "fix", "companion-link"]);

interface DraftFillFault {
  beat: string;
  spec: string;
  detail: string;
}

/** The beats resolve will fill, each with its row; a beat the resolver refuses is left to resolve, which names it. */
function fillableRows(draft: ScriptV1, specs: ReadonlyMap<string, BeatSpec>): ResolvedBeat[] {
  const router = shippedVisualRouter();
  return draft.beats.flatMap((beat) => {
    const found = resolveBeat(beat, specs, router);
    if ("code" in found) return [];
    const ref = specs.get(found.beat)?.slots;
    return ref !== undefined && RUN_FILLED_REFS.has(ref) ? [] : [found];
  });
}

function cueFault(beat: FilledBeat, specs: ReadonlyMap<string, BeatSpec>, failures: readonly EmphasisFailure[]): DraftFillFault {
  const targets = [...new Set(failures.map((f) => f.target))].join(", ");
  const drawn = emphasisTargets(specs.get(beat.spec)!, beat.slots).join(", ") || "none";
  const kind = beat.fallback === undefined ? beat.spec : `the ${beat.spec} it falls back to (${beat.fallback.reason})`;
  return { beat: beat.id, spec: beat.fallback?.from ?? beat.spec, detail: `cue targets ${targets} name no one element of ${kind}; its elements are ${drawn}` };
}

/**
 * Cue targets with no single element in the kind the fill draws, a fallback's included, as the emphasis-target gate
 * at resolve reads them: one fault per beat, so a fallback that orphans a beat's cues fails here, not at resolve. A
 * sim beat that falls back has no slots to sweep, so resolve cuts it and its cues are never drawn.
 */
function cueTargetFaults(draft: ScriptV1, filled: FilledScript, specs: ReadonlyMap<string, BeatSpec>): DraftFillFault[] {
  const { byId, failures } = cueTargetFailures(draft, filled, specs);
  const failed = [...new Set(failures.map((f) => f.beat))];
  return failed.map((id) => cueFault(byId.get(id)!, specs, failures.filter((f) => f.beat === id)));
}

function cueTargetFailures(draft: ScriptV1, filled: FilledScript, specs: ReadonlyMap<string, BeatSpec>) {
  const byId = new Map(filled.beats.filter((beat) => beat.fallback?.from !== SIM_BEAT).map((beat) => [beat.id, beat]));
  const beats = draft.beats.flatMap(({ id, visual }) => (byId.has(id) ? [{ id, visual: { ...visual, beat: byId.get(id)!.spec } }] : []));
  return { byId, failures: emphasisTargetGate({ beats, specs, slots: Object.fromEntries(filled.beats.map((beat) => [beat.id, beat.slots])) }) };
}

/**
 * Per beat, the indexes of the cues whose target names no element the fill draws, for the beats whose every refused
 * cue is such an orphan: a cue that names two elements is left to the repair, since dropping it would hide a choice.
 */
export function orphanCues(draft: ScriptV1, specs: ReadonlyMap<string, BeatSpec> = loadBeatSpecs()): ReadonlyMap<string, readonly number[]> {
  const filled = draftFill(draft, specs);
  if (filled instanceof FillError) return new Map();
  const { failures } = cueTargetFailures(draft, filled, specs);
  const beats = [...new Set(failures.map((f) => f.beat))].filter((beat) => failures.every((f) => f.beat !== beat || f.problem === "no-element"));
  return new Map(beats.map((beat) => [beat, failures.filter((f) => f.beat === beat).map((f) => f.cue)]));
}

/** Resolve's template fill run on the draft's fillable beats, with no slots pin and no code, or the FillError it throws. */
export function draftFill(draft: ScriptV1, specs: ReadonlyMap<string, BeatSpec> = loadBeatSpecs()): FilledScript | FillError {
  const rows = fillableRows(draft, specs);
  const kept = new Set(rows.map((row) => row.id));
  try {
    return fillScript({ ...draft, beats: draft.beats.filter((beat) => kept.has(beat.id)) }, { beats: rows }, { specs });
  } catch (error) {
    if (error instanceof FillError) return error;
    throw error;
  }
}

/**
 * Each beat the draft's fill would refuse, such as a list whose labels overflow the slot schema's five rows, and once
 * every beat fills, each beat whose cue targets name no element of the kind it draws. Dropping a skipped beat changes
 * no later beat's stage, since with no code or links it would fall back to a list, and a fallback opens no stage.
 */
export function draftFillRefusals(draft: ScriptV1): DraftFillFault[] {
  const specs = loadBeatSpecs();
  const filled = draftFill(draft, specs);
  if (!(filled instanceof FillError)) return cueTargetFaults(draft, filled, specs);
  const specOf = new Map(fillableRows(draft, specs).map((row) => [row.id, row.beat]));
  return filled.refusals.map(({ beat, detail }) => ({ beat, spec: specOf.get(beat) ?? "unresolved", detail }));
}

const faultText = ({ beat, spec, detail }: DraftFillFault): string => `template fill: ${beat} (${spec}): ${detail}`;

/** One line per beat resolve's template fill would refuse, naming the beat, its spec and the slot schema's complaint. */
export const draftFillFaults = (draft: ScriptV1): string[] => draftFillRefusals(draft).map(faultText);

/** The draft's template fill as a gate verdict, so the script stage fails the beat resolve would refuse. */
export function draftTemplateFill(draft: ScriptV1): { pass: boolean; detail: string } {
  const faults = draftFillFaults(draft);
  return { pass: faults.length === 0, detail: faults.length === 0 ? "every beat fills its beat spec" : faults.join("; ") };
}

/** One failing error row per refused beat, so an L0 repair round answers each and a reply that adds one counts as worse. */
export const fillRows = (draft: ScriptV1): L0Result[] =>
  draftFillRefusals(draft).map(({ beat }) => ({ check_id: TEMPLATE_FILL_ID, mode: "tagged", severity: "error", value: 1, threshold: 0, pass: false, detail_beats: [beat] }));

/**
 * The rule a repair reads for a template-fill row: the split, since spoken lines and cues move with the labels, and
 * the cue targets, which a fallback's elements must hold.
 */
export const FILL_RULE =
  "a beat's labels fit its beat spec's slots; a beat whose labels overflow its beat spec keeps that many labels and moves the rest to a continuation beat in the same chapter; every cue target names one element of the beat spec the fill draws: when the beat falls back, give its labels what the named fix asks so it fills its own beat spec, or point each cue at an element of the fallback";

/** What the fill refused for the named beats, as a repair round's Found line. */
export const fillHint = (draft: ScriptV1, beats: readonly string[]): string =>
  draftFillRefusals(draft)
    .filter(({ beat }) => beats.includes(beat))
    .map(faultText)
    .join("; ");
