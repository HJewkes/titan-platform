import { loadBeatSpecs } from "./beat-load.js";
import type { BeatSpec } from "./beat-schema.js";
import type { L0Result } from "./eval-l0.js";
import { resolveBeat, type ResolvedBeat } from "./resolve-beat.js";
import type { ScriptV1 } from "./script-schema.js";
import { FillError, fillScript } from "./template-fill/fill.js";
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

/**
 * Resolve's template fill run on the draft, with no slots pin and no code: each beat it would refuse, such as a list
 * whose labels overflow the slot schema's five rows. Dropping a skipped beat changes no later beat's stage, since
 * with no code or links it would fall back to a list, and a fallback opens no stage.
 */
export function draftFillRefusals(draft: ScriptV1): DraftFillFault[] {
  const specs = loadBeatSpecs();
  const rows = fillableRows(draft, specs);
  const kept = new Set(rows.map((row) => row.id));
  try {
    fillScript({ ...draft, beats: draft.beats.filter((beat) => kept.has(beat.id)) }, { beats: rows }, { specs });
    return [];
  } catch (error) {
    if (!(error instanceof FillError)) throw error;
    const specOf = new Map(rows.map((row) => [row.id, row.beat]));
    return error.refusals.map(({ beat, detail }) => ({ beat, spec: specOf.get(beat) ?? "unresolved", detail }));
  }
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

/** The rule a repair reads for a template-fill row: the split, since spoken lines and cues move with the labels. */
export const FILL_RULE =
  "a beat's labels fit its beat spec's slots; a beat whose labels overflow its beat spec keeps that many labels and moves the rest to a continuation beat in the same chapter";

/** What the fill refused for the named beats, as a repair round's Found line. */
export const fillHint = (draft: ScriptV1, beats: readonly string[]): string =>
  draftFillRefusals(draft)
    .filter(({ beat }) => beats.includes(beat))
    .map(faultText)
    .join("; ");
