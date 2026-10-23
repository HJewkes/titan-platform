import type { L0Result } from "./eval-l0.js";
import { boundaryLinks, firstIdentifier, MAX_CONNECTIVE_SHARE, MIN_LINKED, MIN_PLAIN_SHARE, PIVOT_FORM, thesisDefects } from "./lint-flow.js";
import { unsettledHeteronyms } from "./lint-heteronyms.js";
import { THREAD_SHARE } from "./lint-why.js";
import { CUE_KIND_ROLES, fromScriptV1 } from "./pace-items.js";
import type { ScriptV1 } from "./script-schema.js";

type Hint = (script: ScriptV1, row: L0Result) => string | undefined;

const percent = (share: number): string => `${Math.round(share * 100)} %`;
const listed = (ids: readonly string[]): string => (ids.length ? ids.join(", ") : "none");

function linkHint(script: ScriptV1): string {
  const { ratio, unlinked, overused } = boundaryLinks(script.beats);
  const parts = [`${percent(ratio)} of in-chapter boundaries link (needs ${percent(MIN_LINKED)}); unlinked: ${listed(unlinked)}`];
  if (overused) parts.push(`"${overused.word}" opens ${overused.count} of ${overused.linked} linked beats, past the ${percent(MAX_CONNECTIVE_SHARE)} one connective may carry; link the others by a shared word instead`);
  return parts.join("; ");
}

function threadHint(script: ScriptV1, row: L0Result): string | undefined {
  const example = script.video.running_example;
  if (typeof example === "string") return undefined;
  return `running_example.anchor "${example.anchor}" must appear as written in a HOOK beat and in ${percent(THREAD_SHARE)} of HOW beats (spoken, assertion, a label, a chip or the code file); HOW beats without it: ${listed(row.detail_beats)}`;
}

const declarations = (word: string, readings: readonly string[]): string =>
  readings.length ? readings.map((reading) => `[${word}](=${reading})`).join(" or ") : `a [${word}](/phonemes/) override`;

function heteronymHint(script: ScriptV1): string {
  const words = script.beats.flatMap((beat) =>
    unsettledHeteronyms(beat.spoken).map(({ word, readings }) => `${beat.id} "${word}" (write ${declarations(word, readings)})`),
  );
  return `undeclared heteronyms: ${words.join("; ")}`;
}

function plainOpeningHint(script: ScriptV1): string | undefined {
  const first = firstIdentifier(script.beats);
  if (!first) return undefined;
  return `the first identifier the voice says is "${first.word}" in ${first.beat}, after ${percent(first.share)} of the words (needs ${percent(MIN_PLAIN_SHARE)}); say it in plain words there, or name it later`;
}

const projectionFault = (script: ScriptV1, beat: ScriptV1["beats"][number]): string | undefined => {
  try {
    fromScriptV1({ ...script, beats: [beat] });
    return undefined;
  } catch (error) {
    return `${beat.id}: ${(error instanceof Error ? error.message : String(error)).replace(/: add it to CUE_KIND_ROLES$/, "")}`;
  }
};

/** One beat the item track cannot read fails these rows on every beat, so the repair hears the beat and the cause. */
function itemTrackHint(script: ScriptV1): string | undefined {
  const faults = script.beats.flatMap((beat) => projectionFault(script, beat) ?? []);
  if (faults.length === 0) return undefined;
  return `the item track cannot read ${faults.join("; ")}. A cue target is kind:label, with kind one of ${Object.keys(CUE_KIND_ROLES).join(", ")}; fix those cues and this row is measured again`;
}

const ITEM_TRACK_ROWS = ["Q-E7", "Q-E9", "Q-E11", "Q-E16", "Q-E17"] as const;

const HINTS: Readonly<Record<string, Hint>> = {
  "Q-F1": linkHint,
  "Q-F3": threadHint,
  "Q-F4": (script) => thesisDefects(script).join("; "),
  "Q-F5": (_script, row) => `the check counts sentences shaped as ${PIVOT_FORM}; this draft has ${row.value} (${listed(row.detail_beats)}) and needs exactly one, where WHAT turns to HOW`,
  "Q-F16": plainOpeningHint,
  "Q-V10": heteronymHint,
  ...Object.fromEntries(ITEM_TRACK_ROWS.map((id) => [id, itemTrackHint])),
};

/** What a failing row measured, in words a repair can act on, for the rows whose value and beats alone say too little. */
export const repairHint = (row: L0Result, script: ScriptV1): string | undefined => HINTS[row.check_id]?.(script, row);
