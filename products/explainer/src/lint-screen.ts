import { drawnBeats, type DrawnBeat } from "./drawn-beats.js";
import type { L0Check } from "./eval-l0.js";
import { stageHeadings } from "./lint-direction.js";
import { countRow } from "./lint-text.js";
import { unspokenFacts, type ScreenText } from "./qa/narration-facts.js";
import { plainWords, type ScriptBeat, type ScriptV1 } from "./script-schema.js";

/**
 * Script-time preflight for qa's content rows (TP-4470). Each rule reads what the script will put on screen, the
 * assertion, the headings resolve's fill draws, labels and chips, against the beat's spoken text, so the script
 * repair fixes it before a paid render fails narration-facts or G10 on it.
 */

/** qa's G10 line: a display text sharing this many spoken words in a row is the narration read off the screen. */
export const ECHO_RUN_WORDS = 5;

const spokenOf = (beat: ScriptBeat): string => plainWords(beat.spoken).join(" ");

/**
 * Only a beat the fill draws as a chart shows its labels as bars, of which qa takes the largest value as the claim; a
 * chart whose labels fall back to a list, or a beat the fill does not draw, has every number counted.
 */
const drawnAsBars = (drawn: DrawnBeat | undefined): boolean => drawn?.filled.spec === "chart";

/** The beat's on-screen text as the qa probe classes it: the headline, the stage's headings, each label and each chip. */
function screenTexts(beat: ScriptBeat, drawn: DrawnBeat | undefined): ScreenText[] {
  const labelClass = drawnAsBars(drawn) ? "ex-bar-value" : "ex-label";
  return [
    { text: beat.visual.assertion, tag: "h1", cls: "xp-headline" },
    ...(drawn ? stageHeadings(drawn) : []).map((text) => ({ text, tag: "h2", cls: "beat-heading" })),
    ...beat.visual.labels.map((text) => ({ text, tag: "span", cls: labelClass })),
    ...beat.visual.chips.map((chip) => ({ text: chip.text, tag: "span", cls: "xp-chip" })),
  ];
}

/** The numbers the beat shows, as resolve's fill draws it, that its spoken text never says, each with the text that shows it. */
export function unspokenNumbers(script: ScriptV1, beat: ScriptBeat): { fact: string; shown: string }[] {
  const drawn = drawnBeats(script).find((found) => found.filled.id === beat.id);
  return unspokenFacts(beat.id, screenTexts(beat, drawn), spokenOf(beat)).filter((fact) => fact.kind === "number").map(({ fact, shown }) => ({ fact, shown }));
}

const tokens = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9%\s-]/g, " ").split(/\s+/).filter(Boolean);

/** The longest run of consecutive words `display` shares with `spoken`, tokenised as qa's G10 does. */
function sharedRun(display: string, spoken: string): number {
  const shown = tokens(display);
  const heard = tokens(spoken);
  let best = 0;
  for (let i = 0; i < shown.length; i++) {
    for (let j = 0; j < heard.length; j++) {
      let k = 0;
      while (shown[i + k] !== undefined && shown[i + k] === heard[j + k]) k++;
      best = Math.max(best, k);
    }
  }
  return best;
}

/** The labels and chips that repeat at least five of the beat's spoken words in a row. */
export const echoedLabels = (beat: ScriptBeat): string[] =>
  [...beat.visual.labels, ...beat.visual.chips.map((chip) => chip.text)].filter((text) => sharedRun(text, spokenOf(beat)) >= ECHO_RUN_WORDS);

/** Q-D14: every number the assertion, a drawn heading, a label or a chip shows is said in the beat (qa's narration-facts, at script time). */
export const numbersSpokenCheck: L0Check = ({ script }) => [countRow("Q-D14", script.beats.filter((beat) => unspokenNumbers(script, beat).length > 0).map((beat) => beat.id), "tagged")];

/** Q-D16: no label or chip repeats five spoken words in a row (qa's G10, at script time). */
export const labelEchoCheck: L0Check = ({ script }) => [countRow("Q-D16", script.beats.filter((beat) => echoedLabels(beat).length > 0).map((beat) => beat.id), "tagged")];
