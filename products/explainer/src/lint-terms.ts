import type { L0Check } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";
import { beatCues, plainWords, spokenWordIndex, type ScriptBeat } from "./script-schema.js";

/** A cue within this many seconds of a term's first spoken word counts as landing on it. */
const CUE_WINDOW_S = 1.0;

const normal = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Index of the first spoken word where the term's words run on in order, or -1 when the beat never speaks it. */
function termWordIndex(spoken: string, term: string): number {
  const words = plainWords(spoken).map(normal);
  const wanted = normal(term).split(" ");
  return words.findIndex((_, at) => wanted.every((word, offset) => words[at + offset] === word));
}

const shownOnScreen = (beat: ScriptBeat, term: string): boolean =>
  [...beat.visual.labels, ...beat.visual.chips.map((chip) => chip.text)].some((text) => normal(text).includes(normal(term)));

function cueLandsOn(beat: ScriptBeat, wordIndex: number): boolean {
  const total = plainWords(beat.spoken).length;
  const index = spokenWordIndex(beat);
  const secondsPerWord = beat.plannedS / total;
  return beatCues(beat.visual).some((cue) => Math.abs(index(cue) - wordIndex) * secondsPerWord <= CUE_WINDOW_S);
}

const termFails = (beat: ScriptBeat, term: string): boolean => {
  const at = termWordIndex(beat.spoken, term);
  return at === -1 || !shownOnScreen(beat, term) || !cueLandsOn(beat, at);
};

/**
 * Q-V19:term-spoken-shown: a term a beat declares in new_terms is spoken in that beat, shown in its labels or chips,
 * and cued within a second of its first spoken word, so the listener hears and sees it together.
 */
export const termSpokenShownCheck: L0Check = ({ script }) => {
  const failing = script.beats.filter((beat) => beat.new_terms.some((term) => termFails(beat, term))).map((beat) => beat.id);
  return [ruleRow("Q-V19:term-spoken-shown", { value: failing.length, threshold: 0, pass: failing.length === 0, beats: failing, mode: "tagged", severity: "warning" })];
};
