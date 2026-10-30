import type { L0Check } from "./eval-l0.js";
import { drawnBeats, refusedBeats, screenTokens, slotList as list, type DrawnBeat } from "./drawn-beats.js";
import { drawnTexts, type DrawnText } from "./drawn-texts.js";
import { countRow } from "./lint-text.js";
import type { ScriptV1 } from "./script-schema.js";
import type { FilledBeat } from "./template-fill/fill.js";

/**
 * What qa's words-per-frame reads, predicted from the script (TP-4470): the words of the fullest frame a beat draws,
 * by the kind resolve's template fill draws it, without the series chrome qa skips (chapter line, chip kind, list
 * ticks and lanes, map steps). A custom-layer beat, or a kind the page has no view for, is not predicted.
 */

/** qa's words-per-frame line: assertion-evidence slides averaged about 21 words, topic-bullet ones 41. */
export const FRAME_MAX_WORDS = 20;

/** ListFrame's heading yields past this many rows (list-kinds.tsx HEADED_ROWS_MAX), so it never shares a frame with all of them. */
const HEADED_ROWS_MAX = 3;

/** Series chrome qa's words-per-frame skips (timing-gates.ts FRAME_CHROME): a listener reads it once, not per beat. */
const FRAME_CHROME: ReadonlySet<string> = new Set(["xp-chapter", "xp-chapter-count", "xp-chip-kind", "ex-list-tick", "ex-list-ref", "ex-map-step"]);

const LIST_ROWS: Readonly<Record<string, string>> = { list: "rows", "fact-flash": "facts" };

/** A list's heading yields to its rows when the fill says so, or once they outnumber its room. */
function headingYields({ ref, slots, hints }: FilledBeat): boolean {
  const rows = LIST_ROWS[ref];
  return rows !== undefined && ((ref === "list" && hints.headingYields === true) || list(slots, rows).length > HEADED_ROWS_MAX);
}

const isRow = (shown: DrawnText): boolean => shown.cls === "ex-list-text";
const isListHeading = (shown: DrawnText): boolean => shown.cls === "ex-headline";

/** Each frame the beat can show at once: with a yielding heading, the heading over its first rows, then all rows alone. */
function frames(beat: DrawnBeat): DrawnText[][] | undefined {
  const texts = drawnTexts(beat)?.filter((shown) => !FRAME_CHROME.has(shown.cls));
  if (!texts || !headingYields(beat.filled)) return texts && [texts];
  let rows = 0;
  const headed = texts.filter((shown) => !isRow(shown) || ++rows <= HEADED_ROWS_MAX);
  return [headed, texts.filter((shown) => !isListHeading(shown))];
}

/** One beat's fullest predicted frame: the kind it is drawn as and the words on screen together. */
interface FrameCount {
  beat: string;
  kind: string;
  words: number;
}

function frameCount(beat: DrawnBeat): FrameCount | undefined {
  const found = frames(beat);
  if (!found) return undefined;
  const words = Math.max(...found.map((frame) => frame.reduce((sum, shown) => sum + screenTokens(shown.text).length, 0)));
  return { beat: beat.filled.id, kind: beat.filled.spec, words };
}

/** Every template beat's predicted fullest frame. */
export const frameCounts = (script: ScriptV1): FrameCount[] => drawnBeats(script).flatMap((beat) => frameCount(beat) ?? []);

/** Q-D15: no template beat's fullest frame holds more than 20 words (qa's words-per-frame, predicted from the script). */
export const frameWordsCheck: L0Check = ({ script }) => [countRow("Q-D15", [...refusedBeats(script), ...frameCounts(script).filter((count) => count.words > FRAME_MAX_WORDS).map((count) => count.beat)], "tagged")];
