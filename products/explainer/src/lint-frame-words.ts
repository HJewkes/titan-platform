import type { L0Check } from "./eval-l0.js";
import { doctrine } from "./lint-cadence.js";
import { countRow } from "./lint-text.js";
import type { ScriptV1 } from "./script-schema.js";
import { draftFill } from "./script-fill.js";
import type { FilledBeat } from "./template-fill/fill.js";

/**
 * What qa's words-per-frame reads, predicted from the script (TP-4470): the words of the fullest frame a beat draws,
 * by the kind resolve's template fill draws it, without the series chrome qa skips (chapter line, chip kind, list
 * ticks and lanes, map steps). A custom-layer beat, or a kind the page has no view for, is not predicted.
 */

/** qa's words-per-frame line: assertion-evidence slides averaged about 21 words, topic-bullet ones 41. */
export const FRAME_MAX_WORDS = 20;

/** Kinds whose page draws no chrome headline over the stage (registry.tsx `headline: false`, or a page kind). */
export const HEADLINE_FREE_KINDS: ReadonlySet<string> = new Set(["claim-card", "button", "outro", "hook"]);
/** Page kinds own the whole canvas, chrome band included, so no source line shows either. */
const PAGE_KINDS: ReadonlySet<string> = new Set(["hook"]);
/** ListFrame's heading yields past this many rows (list-kinds.tsx HEADED_ROWS_MAX), so it never shares a frame with all of them. */
const HEADED_ROWS_MAX = 3;

/** qa's tokeniser for on-screen text (timing-gates.ts `tokens`). */
const screenTokens = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9%\s-]/g, " ").split(/\s+/).filter(Boolean);

type Slots = Record<string, unknown>;
const list = (slots: Slots, key: string): Slots[] => (Array.isArray(slots[key]) ? (slots[key] as Slots[]) : []);
const text = (value: unknown): string[] => (typeof value === "string" ? [value] : []);
const each = (slots: Slots, key: string, ...fields: string[]): string[] => list(slots, key).flatMap((item) => fields.flatMap((field) => text(item[field])));

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
    case "claim-card": return [[...text(s["claim"]), ...text((s["quote"] as Slots | undefined)?.["text"])]];
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

function frameCount(beat: FilledBeat, headline: string): FrameCount | undefined {
  const frames = stageFrames(beat);
  if (!frames) return undefined;
  const band = [...(HEADLINE_FREE_KINDS.has(beat.spec) ? [] : [headline]), ...sourceLine(beat)];
  const words = Math.max(...frames.map((frame) => [...band, ...frame].reduce((sum, shown) => sum + screenTokens(shown).length, 0)));
  return { beat: beat.id, kind: beat.spec, words };
}

/** Every template beat's predicted fullest frame; a draft the fill refuses predicts none, since template-fill fails it. */
export function frameCounts(script: ScriptV1): FrameCount[] {
  const filled = draftFill(script, doctrine().specs);
  if (!("beats" in filled)) return [];
  const headlines = new Map(script.beats.map((beat) => [beat.id, beat.visual.assertion]));
  return filled.beats.flatMap((beat) => frameCount(beat, headlines.get(beat.id) ?? "") ?? []);
}

/** Q-D15: no template beat's fullest frame holds more than 20 words (qa's words-per-frame, predicted from the script). */
export const frameWordsCheck: L0Check = ({ script }) => [countRow("Q-D15", frameCounts(script).filter((count) => count.words > FRAME_MAX_WORDS).map((count) => count.beat), "tagged")];
