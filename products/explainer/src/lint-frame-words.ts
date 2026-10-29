import type { L0Check } from "./eval-l0.js";
import { drawnBeats, isSlots, PAGE_KINDS, screenTokens, slotEach as each, slotList as list, slotText as text, type DrawnBeat, type Slots } from "./drawn-beats.js";
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

/** A heading over rows, as ListFrame draws it: with them all, or yielding to them once they outnumber its room. */
function headed(heading: string[], rows: string[], yields: boolean): string[][] {
  return yields ? [[...heading, ...rows.slice(0, HEADED_ROWS_MAX)], rows] : [[...heading, ...rows]];
}

const crowds = (slots: Slots, key: string): boolean => list(slots, key).length > HEADED_ROWS_MAX;

const figureText = (figure: Slots): string[] => [...text(figure["label"]), String(figure["value"]), ...text(figure["unit"])];
const barValue = (point: Slots, cap: unknown): string => (cap === undefined ? Number(point["value"]).toLocaleString("en-US") : `${String(point["value"])} / ${String(cap)}`);
const pointText = (point: Slots, cap: unknown): string[] => [...text(point["label"]), barValue(point, cap)];

/** Each frame the stage can show at once, as text; undefined for a slot ref the page draws no view for. */
function stageFrames(beat: FilledBeat): string[][] | undefined {
  const s = beat.slots;
  switch (beat.ref) {
    case "list": return headed(text(s["title"]), each(s, "rows", "text"), beat.hints.headingYields === true || crowds(s, "rows"));
    case "verdict-card": return [[...text(s["verdict"]), ...each(s, "reasons", "text")]];
    case "fact-flash": return headed([], each(s, "facts", "text"), crowds(s, "facts"));
    case "claim-card": return [[...text(s["claim"]), ...(isSlots(s["quote"]) ? text(s["quote"]["text"]) : [])]];
    case "stat": return [list(s, "figures").flatMap(figureText)];
    case "chart": return [[...(s["kind"] === "line" ? [...text(s["title"]), ...text(s["unit"])] : []), ...list(s, "series").flatMap((point) => pointText(point, s["cap"]))]];
    case "map": return [[...text(s["title"]), ...each(s, "nodes", "label")]];
    case "compare": return [[...text(s["leftTitle"]), ...text(s["rightTitle"]), ...each(s, "rows", "left", "right")]];
    case "button": return [[...text(s["line"]), ...text(s["action"])]];
    case "outro":
    case "held": return [text(s["line"])];
    case "hook": return [[...text(s["line"]), ...each(s, "cards", "text")]];
    default: return undefined;
  }
}

/** The chrome's one source line: the first chip's first ref, its path cut as the chrome cuts it. */
function sourceLine(beat: FilledBeat): string[] {
  const first = beat.chips[0]?.text.split("; ")[0];
  return first === undefined || PAGE_KINDS.has(beat.spec) ? [] : [first.replace(/^[\w-]+@[0-9a-f]+:/, "").replace(/(?:[\w.~-]+\/)+/g, "")];
}

/** One beat's fullest predicted frame: the kind it is drawn as and the words on screen together. */
interface FrameCount {
  beat: string;
  kind: string;
  words: number;
}

function frameCount({ filled, headline }: DrawnBeat): FrameCount | undefined {
  const frames = stageFrames(filled);
  if (!frames) return undefined;
  const band = [...(headline === undefined ? [] : [headline]), ...sourceLine(filled)];
  const words = Math.max(...frames.map((frame) => [...band, ...frame].reduce((sum, shown) => sum + screenTokens(shown).length, 0)));
  return { beat: filled.id, kind: filled.spec, words };
}

/** Every template beat's predicted fullest frame. */
export const frameCounts = (script: ScriptV1): FrameCount[] => drawnBeats(script).flatMap((beat) => frameCount(beat) ?? []);

/** Q-D15: no template beat's fullest frame holds more than 20 words (qa's words-per-frame, predicted from the script). */
export const frameWordsCheck: L0Check = ({ script }) => [countRow("Q-D15", frameCounts(script).filter((count) => count.words > FRAME_MAX_WORDS).map((count) => count.beat), "tagged")];
