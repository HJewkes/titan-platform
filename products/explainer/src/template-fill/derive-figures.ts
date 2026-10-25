import type { ScriptBeat } from "../script-schema.js";
import { chapterTitle } from "./derive-rows.js";
import { chartPoint, cueWords, dayLabel, isDateName, itemReveals } from "./label-parse.js";
import type { BeatScope, Derivation } from "./types.js";

const FIGURE = /(-?\d[\d,]*(?:\.\d+)?)\s*(%)?/;
// A trend needs three points; fewer by day still read as bars (the sample builder's GRAPH_POINTS_MIN).
const GRAPH_POINTS_MIN = 3;

/** A label's first number as a figure, `%` as its unit when it follows, the rest of the label as its label. */
export function figureOf(label: string, id: string): Record<string, unknown> | undefined {
  const found = FIGURE.exec(label);
  if (!found) return undefined;
  const rest = `${label.slice(0, found.index)} ${label.slice(found.index + found[0].length)}`.replace(/\s+/g, " ").trim();
  return { id, value: Number(found[1]!.replace(/,/g, "")), ...(found[2] ? { unit: found[2] } : {}), label: rest || label };
}

/** One figure a label when every label carries a number. */
export function deriveStat(beat: ScriptBeat): Derivation {
  const { labels } = beat.visual;
  const figures = labels.map((label, i) => figureOf(label, `figures-${i + 1}`));
  if (labels.length === 0 || figures.some((figure) => figure === undefined)) return { reason: "stat needs a number in every label" };
  return { slots: { figures }, reveals: itemReveals(beat, "figures", figures.length) };
}

/** The cost is the assertion; the labels that carry a number are its figures. */
export function deriveStakes(beat: ScriptBeat): Derivation {
  const numeric = beat.visual.labels.filter((label) => FIGURE.test(label));
  const figures = numeric.map((label, i) => figureOf(label, `figures-${i + 1}`));
  return { slots: { cost: beat.visual.assertion, figures }, reveals: itemReveals(beat, "figures", figures.length) };
}

/**
 * `name: number` labels as a chart: a line when there are 3 or more points and every name is a date (ISO days read
 * `MM-DD`), each point on its cue; else bars, revealed on the first bar's cue only, as the sample builder cues them.
 */
export function deriveChart(beat: ScriptBeat, scope: BeatScope): Derivation {
  const { labels } = beat.visual;
  const points = labels.map(chartPoint);
  if (labels.length === 0 || points.some((point) => point === undefined)) return { reason: "chart needs a `name: number` pair in every label" };
  const pairs = points.filter((point) => point !== undefined);
  const line = pairs.length >= GRAPH_POINTS_MIN && pairs.every((point) => isDateName(point.name));
  const series = pairs.map((point, i) => ({ id: `series-${i + 1}`, label: line ? dayLabel(point.name) : point.name, value: point.value }));
  if (line) return { slots: { kind: "line", ...chapterTitle(scope), series }, reveals: itemReveals(beat, "series", series.length) };
  return { slots: { kind: "bar", series }, reveals: [{ target: "series-1", atCue: cueWords(beat, 1)[0]! }] };
}
