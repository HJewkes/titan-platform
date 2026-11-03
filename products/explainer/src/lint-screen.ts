import { drawnBeats } from "./drawn-beats.js";
import { drawnTexts } from "./drawn-texts.js";
import type { L0Check } from "./eval-l0.js";
import { countRow } from "./lint-text.js";
import { unspokenFacts, type ScreenText } from "./qa/narration-facts.js";
import { sharedRun } from "./qa/timing-gates.js";
import { plainWords, type ScriptBeat, type ScriptV1 } from "./script-schema.js";

/**
 * Script-time preflight for qa's content rows (TP-4470). Each rule reads the beat's texts from the drawn-text model,
 * with the tag and class qa's probe will read them under, against the beat's spoken text, so the script repair fixes
 * it before a paid render fails narration-facts or G10 on it. A beat the model does not predict (a custom layer, or a
 * draft the fill refuses) is read from its own fields, every label counted.
 */

/** qa's G10 line: a display text sharing this many spoken words in a row is the narration read off the screen. */
export const ECHO_RUN_WORDS = 5;

const spokenOf = (beat: ScriptBeat): string => plainWords(beat.spoken).join(" ");

/** The script's own fields as on-screen text, for a beat the model does not predict. */
const scriptTexts = (beat: ScriptBeat): ScreenText[] => [
  { text: beat.visual.assertion, tag: "h1", cls: "xp-headline" },
  ...beat.visual.labels.map((text) => ({ text, tag: "span", cls: "ex-label" })),
  ...beat.visual.chips.map((chip) => ({ text: chip.text, tag: "p", cls: "xp-chips" })),
];

/** The beat's on-screen texts as qa's probe reads them. */
function screenTexts(script: ScriptV1, beat: ScriptBeat): ScreenText[] {
  const drawn = drawnBeats(script).find((found) => found.filled.id === beat.id);
  return (drawn && drawnTexts(drawn)) ?? scriptTexts(beat);
}

type UnspokenNumber = { fact: string; shown: string };

const unspokenIn = (beat: ScriptBeat, texts: readonly ScreenText[]): UnspokenNumber[] =>
  unspokenFacts(beat.id, texts, spokenOf(beat)).filter((fact) => fact.kind === "number").map(({ fact, shown }) => ({ fact, shown }));

/** The numbers the beat shows that its spoken text never says, each with the text that shows it. */
export const unspokenNumbers = (script: ScriptV1, beat: ScriptBeat): UnspokenNumber[] => unspokenIn(beat, screenTexts(script, beat));

/** Q-D14 on one beat's own assertion, labels and chips, for a caller that holds the beat but not the script it is drawn in. */
export const unspokenFieldNumbers = (beat: ScriptBeat): UnspokenNumber[] => unspokenIn(beat, scriptTexts(beat));

/** The on-screen texts that repeat at least five of the beat's spoken words in a row. */
export const echoedLabels = (script: ScriptV1, beat: ScriptBeat): string[] =>
  [...new Set(screenTexts(script, beat).map((shown) => shown.text))].filter((text) => sharedRun(text, spokenOf(beat)) >= ECHO_RUN_WORDS);

/** Q-D14: every number the beat draws is said in the beat (qa's narration-facts, at script time). */
export const numbersSpokenCheck: L0Check = ({ script }) => [countRow("Q-D14", script.beats.filter((beat) => unspokenNumbers(script, beat).length > 0).map((beat) => beat.id), "tagged")];

/** Q-D16: no text the beat draws repeats five spoken words in a row (qa's G10, at script time). */
export const labelEchoCheck: L0Check = ({ script }) => [countRow("Q-D16", script.beats.filter((beat) => echoedLabels(script, beat).length > 0).map((beat) => beat.id), "tagged")];
