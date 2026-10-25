import { spokenWordIndex, type ScriptBeat } from "../script-schema.js";
import type { Reveal } from "./types.js";

// Ports of the spike sample builder's label conventions (TP-4115 S6b, S7, S9), so a daily script fills the same rows.

const MARKS = ["tick", "cross", "risk", "open", "dot"] as const;
export type Mark = (typeof MARKS)[number];

const LANE_ROW = /^([\p{L}\p{N}_-]{1,12}) · (.+)$/u;
const CHART_ROW = /^(.+?):\s*(-?\d[\d,]*(?:\.\d+)?)\s*$/;
const DATE =
  /^(?:(?:\d{4}-)?\d{1,2}[-/]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)$/i;
const ISO_DAY = /^\d{4}-(\d{2}-\d{2})$/;
const COMPARE_ROW = /^(before|after):\s*(.+)$/i;
const NUMBERED_TARGET = /-(\d+)$/;
// The page's firstCueFraction budget: a beat whose first element lands later than this shows a placeholder first.
const FIRST_CUE_FRACTION = 0.3;

const isMark = (word: string): word is Mark => (MARKS as readonly string[]).includes(word);

/** `crew · Night shift` is the row `Night shift` in lane `crew`. */
function laned(text: string): { text: string; lane?: string } {
  const found = LANE_ROW.exec(text);
  return found ? { text: found[2]!, lane: found[1]! } : { text };
}

/** A list row's text, mark and lane: the mark is the label's first word when it names one, else `dot`. */
export function marked(label: string): { text: string; mark: Mark; lane?: string } {
  const space = label.indexOf(" ");
  const head = space < 0 ? "" : label.slice(0, space).toLowerCase();
  const rest = space < 0 ? "" : label.slice(space + 1);
  if (isMark(head) && rest !== "") return { ...laned(rest), mark: head };
  return { ...laned(label), mark: "dot" };
}

/** A `name: number` chart label, commas stripped from the number. */
export function chartPoint(label: string): { name: string; value: number } | undefined {
  const found = CHART_ROW.exec(label);
  return found ? { name: found[1]!.trim(), value: Number(found[2]!.replace(/,/g, "")) } : undefined;
}

export const isDateName = (name: string): boolean => DATE.test(name);

/** An ISO day reads as its month and day under a trend point. */
export const dayLabel = (name: string): string => name.replace(ISO_DAY, "$1");

/** A `before: …` or `after: …` label as its compare side. */
export function compareSide(label: string): { side: "left" | "right"; text: string } | undefined {
  const found = COMPARE_ROW.exec(label);
  if (!found) return undefined;
  return { side: found[1]!.toLowerCase() === "before" ? "left" : "right", text: found[2]!.trim() };
}

const norm = (word: string): string => word.toLowerCase().replace(/[^a-z0-9%]/g, "");

/** The first spoken word with a letter or digit in it: where an element with no cue of its own lands. */
export function firstWord(beat: Pick<ScriptBeat, "spoken">): string {
  return beat.spoken.split(/\s+/).find((word) => norm(word) !== "") ?? beat.spoken;
}

/** Each `<field>-<n>` cue target's first cue word, by n: any field, as the sample builder reads them. */
function numberedCues(beat: Pick<ScriptBeat, "visual">): Map<number, string> {
  const byN = new Map<number, string>();
  for (const cue of beat.visual.cues) {
    const n = NUMBERED_TARGET.exec(cue.target);
    if (n && !byN.has(Number(n[1]))) byN.set(Number(n[1]), cue.atCue);
  }
  return byN;
}

/** The cue word of each of `count` items, numbered from 1; a missing one takes the one before it, the first the first word. */
export function cueWords(beat: Pick<ScriptBeat, "spoken" | "visual">, count: number): string[] {
  const byN = numberedCues(beat);
  let last = firstWord(beat);
  return Array.from({ length: count }, (_, i) => (last = byN.get(i + 1) ?? last));
}

/** One reveal per item of `field`, ids `<field>-<n>`, on the items' cue words. */
export const itemReveals = (beat: Pick<ScriptBeat, "spoken" | "visual">, field: string, count: number): Reveal[] =>
  cueWords(beat, count).map((atCue, i) => ({ target: `${field}-${i + 1}`, atCue }));

/** Whether the earliest reveal lands past 30 % of the spoken words; a cue the beat never speaks is ignored. */
export function lateFirstCue(beat: Pick<ScriptBeat, "id" | "spoken">, reveals: readonly Reveal[]): boolean {
  const index = spokenWordIndex(beat);
  const words = beat.spoken.split(/\s+/).length;
  const firsts = reveals.flatMap(({ atCue }) => {
    try {
      return [index(atCue)];
    } catch {
      return [];
    }
  });
  return firsts.length > 0 && Math.min(...firsts) / words > FIRST_CUE_FRACTION;
}
