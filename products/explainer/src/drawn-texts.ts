import { isSlots, PAGE_KINDS, slotEach as each, slotList as list, slotText as text, type DrawnBeat, type Slots } from "./drawn-beats.js";
import type { ScreenText } from "./qa/narration-facts.js";
import type { FilledBeat } from "./template-fill/fill.js";

/**
 * The one script-time model of what qa's probe reads off a drawn beat (TP-4470): each text the page draws, with the tag
 * and class the probe records for it (the text's parent tag, the nearest class). The view markup it mirrors is cited per
 * kind. Every script-time prediction of a qa row that reads text classes reads this, so none re-derives them.
 */

export type DrawnText = ScreenText;

const drawnAs = (tag: string, cls: string) => (texts: readonly string[]): DrawnText[] => texts.map((shown) => ({ text: shown, tag, cls }));

/** ListFrame (ListBeat.tsx): an h2 heading over rows, each row's text and its lane. */
const listFrame = (heading: string[], rows: string[], lanes: string[] = []): DrawnText[] =>
  [...drawnAs("h2", "ex-headline")(heading.filter(Boolean)), ...drawnAs("span", "ex-list-text")(rows), ...drawnAs("span", "ex-list-ref")(lanes)];

const barValue = (point: Slots, cap: unknown): string => (cap === undefined ? Number(point["value"]).toLocaleString("en-US") : `${String(point["value"])} / ${String(cap)}`);

/** ChartKindBeat: a bar chart's label and value rows (BarChartBeat.tsx), a line chart's titled day bars (GraphBeat.tsx). */
function chartTexts(s: Slots): DrawnText[] {
  const series = list(s, "series");
  const legend = s["legend"] === true ? drawnAs("li", "ex-chart-legend-entry")(each(s, "series", "label")) : [];
  if (s["kind"] !== "line") return [...drawnAs("span", "ex-bar-label")(each(s, "series", "label")), ...drawnAs("span", "ex-bar-value")(series.map((point) => barValue(point, s["cap"]))), ...legend];
  const title = text(s["title"]).map((shown) => (typeof s["unit"] === "string" ? `${shown} (${s["unit"]})` : shown));
  const values = series.map((point) => String(point["value"]));
  return [...drawnAs("h2", "beat-heading")(title), ...drawnAs("span", "beat-graph-value")(values), ...drawnAs("span", "beat-graph-labels")(each(s, "series", "label")), ...legend];
}

const figureTexts = (figure: Slots): DrawnText[] =>
  [...drawnAs("span", "beat-stat-label")(text(figure["label"])), ...drawnAs("span", "beat-stat-prefix")(text(figure["prefix"])), ...drawnAs("span", "beat-stat-figure")([String(figure["value"])]), ...drawnAs("span", "beat-stat-unit")(text(figure["unit"]))];

/** ClaimCardBeat (TitleBeat.tsx): the claim a word to a span, its quote a quoted subtitle. */
function claimTexts(s: Slots): DrawnText[] {
  const quote = isSlots(s["quote"]) ? text(s["quote"]["text"]).map((shown) => `“${shown}”`) : [];
  return [...drawnAs("span", "beat-word")(text(s["claim"]).flatMap((claim) => claim.split(/\s+/).filter(Boolean))), ...drawnAs("p", "beat-subtitle")(quote)];
}

/** ArchMapBeat.tsx: the title, then each node's step number and label. */
const mapTexts = (s: Slots): DrawnText[] => [
  ...drawnAs("h2", "ex-headline")(text(s["title"])),
  ...drawnAs("span", "ex-map-step")(list(s, "nodes").map((_, k) => String(k + 1))),
  ...drawnAs("span", "ex-map-label")(each(s, "nodes", "label")),
];

/** The texts the stage draws by slot ref; undefined for a ref the page draws no view for. */
function stageTexts({ ref, slots: s }: FilledBeat, chapter: string): DrawnText[] | undefined {
  switch (ref) {
    case "list": return listFrame(text(s["title"]), each(s, "rows", "text"), each(s, "rows", "lane"));
    case "verdict-card": return listFrame(text(s["verdict"]), each(s, "reasons", "text"));
    case "fact-flash": return listFrame([chapter], each(s, "facts", "text"));
    case "map": return mapTexts(s);
    case "chart": return chartTexts(s);
    case "stat": return list(s, "figures").flatMap(figureTexts);
    case "button": return [...drawnAs("h1", "beat-title")(text(s["line"])), ...drawnAs("a", "beat-outro-links")(text(s["action"]))];
    case "outro": return drawnAs("h1", "beat-title")(text(s["line"]));
    case "claim-card": return claimTexts(s);
    case "compare": return [...drawnAs("div", "beat-compare-title")([...text(s["leftTitle"]), ...text(s["rightTitle"])]), ...drawnAs("div", "beat-compare-row")(each(s, "rows", "left", "right"))];
    case "held": return drawnAs("p", "beat-heading")(text(s["line"]));
    case "hook": return [...drawnAs("h1", "typography")(text(s["line"])), ...drawnAs("h3", "typography")(each(s, "cards", "text"))];
    default: return undefined;
  }
}

const shortRef = (ref: string): string => ref.replace(/^[\w-]+@[0-9a-f]+:/, "").replace(/(?:[\w.~-]+\/)+/g, "");

/** Chrome.tsx's bands: the headline, the first source cut short, and the chapter line; a page kind draws none. */
function chromeTexts({ filled, headline, chapter }: DrawnBeat): DrawnText[] {
  if (PAGE_KINDS.has(filled.spec)) return [];
  const refs = filled.chips.flatMap((chip) => chip.text.split("; ").map((ref) => ({ kind: chip.kind, ref })));
  const first = refs[0];
  return [
    ...drawnAs("h1", "xp-headline")(headline === undefined ? [] : [headline]),
    ...(first === undefined ? [] : [...drawnAs("span", "xp-chip-kind")([first.kind]), ...drawnAs("p", "xp-chips")([shortRef(first.ref)])]),
    ...drawnAs("span", "xp-chip-more")(refs.length > 1 ? [`+${refs.length - 1}`] : []),
    ...drawnAs("p", "xp-chapter")(chapter ? [chapter] : []),
  ];
}

/** Every text the beat draws, chrome first; undefined when the page has no view for its slot ref, so it is not predicted. */
export function drawnTexts(beat: DrawnBeat): DrawnText[] | undefined {
  const stage = stageTexts(beat.filled, beat.chapter);
  return stage && [...chromeTexts(beat), ...stage];
}

/** qa's G9 reads an h1 or h2 as a heading and a text whose class names a label as a label (timing-gates.ts g9Labels). */
export const isHeading = (shown: DrawnText): boolean => shown.tag === "h1" || shown.tag === "h2";
export const isLabel = (shown: DrawnText): boolean => /label/.test(shown.cls);
