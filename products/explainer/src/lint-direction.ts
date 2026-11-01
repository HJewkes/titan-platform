import { drawnBeats, PAGE_KINDS, refusedBeats, screenTokens, type DrawnBeat } from "./drawn-beats.js";
import { drawnTexts, isHeading, isLabel, type DrawnText } from "./drawn-texts.js";
import type { L0Check } from "./eval-l0.js";
import { countRow } from "./lint-text.js";
import type { ScriptV1 } from "./script-schema.js";
import { DEFAULT_PADDING } from "./workflow/tts-truing.js";

/**
 * qa's G9 and G7 predicted from the script (TP-4470), on the kind each template beat is drawn as. G9 reads every
 * heading (h1 or h2) and every label-class text in the drawn-text model; G7 asks whether anything moves within 0.2 s
 * of the cut. A custom layer, or a kind the page has no view for, is not predicted.
 */

/** G9: a heading holds at most 10 words and a label at most 3. */
export const HEADING_MAX_WORDS = 10;
export const LABEL_MAX_WORDS = 3;
/** G7: the picture first moves within this long of its cut. */
const FIRST_MOTION_S = 0.2;
/** The chrome's own entrances (Chrome.tsx): the headline rises at 0.05 s, the source line at 0.15 s. */
const HEADLINE_RISE_S = 0.05;
const SOURCE_RISE_S = 0.15;

interface ShownText {
  role: "heading" | "label";
  text: string;
}

/** The text with the role G9 fails it under, or undefined within both caps; a label-class heading is held to the label cap. */
function overCap(shown: DrawnText): ShownText | undefined {
  const words = screenTokens(shown.text).length;
  if (isLabel(shown) && words > LABEL_MAX_WORDS) return { role: "label", text: shown.text };
  if (isHeading(shown) && words > HEADING_MAX_WORDS) return { role: "heading", text: shown.text };
  return undefined;
}

/** Each predicted beat's headings and labels over G9's caps. */
export const overlongTexts = (script: ScriptV1): { beat: string; kind: string; texts: ShownText[] }[] =>
  drawnBeats(script).flatMap((beat) => {
    const texts = (drawnTexts(beat) ?? []).flatMap((shown) => overCap(shown) ?? []);
    return texts.length > 0 ? [{ beat: beat.filled.id, kind: beat.filled.spec, texts }] : [];
  });

/** The stage element a headline-free kind opens on: it enters on its cue, or at once when it has none. */
const OPENING_TARGET: Readonly<Record<string, string>> = { "claim-card": "claim", button: "line", outro: "line" };

/**
 * Seconds into the beat its picture first moves, or undefined when the kind is not predicted. The voice starts after
 * its lead-in, so a cue on even the first spoken word comes later than that.
 */
function firstMotionS({ filled, headline }: DrawnBeat): number | undefined {
  if (headline !== undefined) return HEADLINE_RISE_S;
  if (filled.chips.length > 0 && !PAGE_KINDS.has(filled.spec)) return SOURCE_RISE_S;
  const target = OPENING_TARGET[filled.spec];
  if (target === undefined) return undefined;
  return filled.reveals.some((reveal) => reveal.target === target) ? DEFAULT_PADDING.leadS : 0;
}

/** Predicted beats whose picture holds still past 0.2 s after its cut, with the kind each is drawn as. */
export const stillOpenings = (script: ScriptV1): { beat: string; kind: string; firstS: number }[] =>
  drawnBeats(script).flatMap((beat) => {
    const firstS = firstMotionS(beat);
    return firstS !== undefined && firstS > FIRST_MOTION_S ? [{ beat: beat.filled.id, kind: beat.filled.spec, firstS }] : [];
  });

/** Q-D20: no heading the page draws holds more than 10 words, and no label more than 3 (qa's G9, predicted). */
export const headingWordsCheck: L0Check = ({ script }) => [countRow("Q-D20", [...refusedBeats(script), ...overlongTexts(script).map((found) => found.beat)], "tagged")];

/** Q-D21: every predicted beat's picture moves within 0.2 s of its cut (qa's G7, predicted). */
export const firstMotionCheck: L0Check = ({ script }) => [countRow("Q-D21", [...refusedBeats(script), ...stillOpenings(script).map((found) => found.beat)], "tagged")];
