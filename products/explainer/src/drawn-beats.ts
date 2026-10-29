import { doctrine } from "./lint-cadence.js";
import type { ScriptV1 } from "./script-schema.js";
import { draftFill } from "./script-fill.js";
import type { FilledBeat } from "./template-fill/fill.js";

/**
 * The script's template beats as the page will draw them (TP-4470): resolve's template fill, fallbacks included, which
 * render draws as the same kind since TP-4468. The script-time predictions of qa's on-screen rows all read this.
 */

/** Kinds whose page draws no chrome headline over the stage (registry.tsx `headline: false`, or a page kind). */
export const HEADLINE_FREE_KINDS: ReadonlySet<string> = new Set(["claim-card", "button", "outro", "hook"]);
/** Page kinds own the whole canvas, chrome band included, so no source line shows either. */
export const PAGE_KINDS: ReadonlySet<string> = new Set(["hook"]);

/** qa's tokeniser for on-screen text (timing-gates.ts `tokens`). */
export const screenTokens = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9%\s-]/g, " ").split(/\s+/).filter(Boolean);

export type Slots = Record<string, unknown>;
export const isSlots = (value: unknown): value is Slots => typeof value === "object" && value !== null && !Array.isArray(value);
export const slotList = (slots: Slots, key: string): Slots[] => {
  const value: unknown = slots[key];
  return Array.isArray(value) ? value.filter(isSlots) : [];
};
export const slotText = (value: unknown): string[] => (typeof value === "string" ? [value] : []);
export const slotEach = (slots: Slots, key: string, ...fields: string[]): string[] =>
  slotList(slots, key).flatMap((item) => fields.flatMap((field) => slotText(item[field])));

/** One template beat as drawn, with the script text the page draws beside its slots. */
export interface DrawnBeat {
  filled: FilledBeat;
  /** The chrome headline, when the drawn kind shows one. */
  headline?: string;
  /** The beat's chapter label, which fact-flash draws as its heading. */
  chapter: string;
}

const drawnByScript = new WeakMap<ScriptV1, DrawnBeat[]>();

function drawn(script: ScriptV1): DrawnBeat[] {
  const filled = draftFill(script, doctrine().specs);
  if (!("beats" in filled)) return [];
  const beats = new Map(script.beats.map((beat) => [beat.id, beat]));
  const chapters = new Map(script.chapters.map((chapter) => [chapter.id, chapter.label]));
  return filled.beats.map((beat) => {
    const source = beats.get(beat.id);
    const headline = HEADLINE_FREE_KINDS.has(beat.spec) ? undefined : source?.visual.assertion;
    return { filled: beat, ...(headline === undefined ? {} : { headline }), chapter: chapters.get(source?.chapter ?? "") ?? "" };
  });
}

/** Every template beat as drawn, read once per script; a draft the fill refuses draws none, since template-fill fails it. */
export function drawnBeats(script: ScriptV1): DrawnBeat[] {
  const known = drawnByScript.get(script);
  if (known) return known;
  const found = drawn(script);
  drawnByScript.set(script, found);
  return found;
}
