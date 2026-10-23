import type { L0Result } from "./eval-l0.js";
import { boundaryLinks, MAX_CONNECTIVE_SHARE, MIN_LINKED, PIVOT_FORM, thesisDefects } from "./lint-flow.js";
import { unsettledHeteronyms } from "./lint-heteronyms.js";
import { THREAD_SHARE } from "./lint-why.js";
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

const HINTS: Readonly<Record<string, Hint>> = {
  "Q-F1": linkHint,
  "Q-F3": threadHint,
  "Q-F4": (script) => thesisDefects(script).join("; "),
  "Q-F5": (_script, row) => `the check counts sentences shaped as ${PIVOT_FORM}; this draft has ${row.value} (${listed(row.detail_beats)}) and needs exactly one, where WHAT turns to HOW`,
  "Q-V10": heteronymHint,
};

/** What a failing row measured, in words a repair can act on, for the rows whose value and beats alone say too little. */
export const repairHint = (row: L0Result, script: ScriptV1): string | undefined => HINTS[row.check_id]?.(script, row);
