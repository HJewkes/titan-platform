import { BEAT_SLOTS } from "./beat-slots.js";
import { FillError, type FilledBeat } from "./template-fill/fill.js";
import { fillAtResolve } from "./resolve-stage.js";
import type { CheckInput } from "./workflow/stage-checks.js";

/**
 * The chart-integrity lints resolve gates on: a bar's length is its value only from a zero baseline (CH-11, Correll
 * 2020), an axis-break glyph does not undo a truncated bar (CH-13), a colour scale reads in order only when its
 * lightness does (CH-22), and a legend makes the viewer match colours where a label on the series would do (CH-20).
 */

interface ChartFrame {
  kind: string;
  baseline?: number;
  axisBreak?: boolean;
  scale?: { kind: "sequential" | "diverging"; colours: string[] };
  legend?: boolean;
  series: unknown[];
}

/** A chart beat's series count: a `chart` draws one series of points, a `replot` one line or bar set per series. */
const seriesCount = (ref: string, frame: ChartFrame): number => (ref === "replot" ? frame.series.length : 1);

/** Up to this many series, each one's label fits at its end, so a legend only adds a colour lookup. */
const DIRECT_LABEL_MAX = 6;

const CHART_REFS = new Set(["chart", "replot"]);

/** A filled beat's slots, already accepted by its schema, read again as the chart frame they carry. */
const frameOf = (ref: string, slots: unknown): ChartFrame => (ref === "replot" ? BEAT_SLOTS.replot : BEAT_SLOTS.chart).parse(slots);

const linear = (channel: number): number => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);

/** CIELAB L* of an sRGB `#rrggbb` colour, D65 white. */
export function lightness(hex: string): number {
  const channel = (at: number): number => linear(Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const y = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  const f = y > (6 / 29) ** 3 ? Math.cbrt(y) : y / (3 * (6 / 29) ** 2) + 4 / 29;
  return 116 * f - 16;
}

const steps = (values: readonly number[]): number[] => values.slice(1).map((value, i) => Math.sign(value - values[i]!));

/** Sequential: L* strictly rises or strictly falls. Diverging: it strictly rises to one interior peak, then falls. */
export function isMonotonicScale(kind: "sequential" | "diverging", colours: readonly string[]): boolean {
  const signs = steps(colours.map(lightness));
  if (signs.includes(0)) return false;
  if (kind === "sequential") return signs.every((sign) => sign === signs[0]);
  const peak = signs.indexOf(-1);
  return peak > 0 && signs.slice(peak).every((sign) => sign === -1);
}

function barProblems(frame: ChartFrame): string[] {
  if (frame.kind !== "bar") return [];
  return [
    ...(frame.baseline !== undefined && frame.baseline > 0 ? [`bars start at ${frame.baseline}, not zero; plot a dot or line chart, or the differences`] : []),
    ...(frame.axisBreak ? ["bars draw a broken axis; a break does not undo a truncated bar"] : []),
  ];
}

/** What is wrong with one chart beat's axis, colour scale and labels; empty when it reads true. */
export function chartFrameProblems(ref: string, frame: ChartFrame): string[] {
  const { scale } = frame;
  return [
    ...barProblems(frame),
    ...(scale && !isMonotonicScale(scale.kind, scale.colours) ? [`its ${scale.kind} colour scale's lightness is not monotonic`] : []),
    ...(frame.legend && seriesCount(ref, frame) <= DIRECT_LABEL_MAX ? ["it draws a legend where direct labels fit; label each series instead"] : []),
  ];
}

/** Every problem over the filled chart and replot beats, each named by its beat id. */
function chartIntegrityProblems(beats: readonly Pick<FilledBeat, "id" | "ref" | "slots">[]): string[] {
  return beats.filter((beat) => CHART_REFS.has(beat.ref)).flatMap((beat) => chartFrameProblems(beat.ref, frameOf(beat.ref, beat.slots)).map((problem) => `${beat.id}: ${problem}`));
}

/** The `chart-integrity` gate over the fill the resolve body ran; a refused fill fails it beside the template-fill gate. */
export function chartIntegrityVerdict(input: CheckInput): { pass: boolean; detail: string } {
  const filled = fillAtResolve(input);
  if (filled instanceof FillError) throw new Error("the template fill refused; the template-fill gate names the beats");
  const charts = filled.beats.filter((beat) => CHART_REFS.has(beat.ref)).length;
  const problems = chartIntegrityProblems(filled.beats);
  const shown = problems.slice(0, 5).join("; ") + (problems.length > 5 ? ` and ${problems.length - 5} more` : "");
  return { pass: problems.length === 0, detail: problems.length === 0 ? `${charts} chart beats read true` : `chart integrity: ${shown}` };
}

/**
 * Whether a chart tells its series apart by colour alone (CH-20, WCAG 1.4.1): a replot of two or more series keyed
 * by a legend. The slots carry no marker, dash or pattern, so without labels on the series colour is the only key.
 * A chart beat draws one series whose every point has its own axis label, so it never is.
 */
export const colourOnlySeries = (ref: string, frame: ChartFrame): boolean => ref === "replot" && seriesCount(ref, frame) > 1 && frame.legend === true;

/** The reported `colour-only-series` lint over the fill the resolve body ran. */
export function colourOnlySeriesVerdict(input: CheckInput): { pass: boolean; detail: string } {
  const filled = fillAtResolve(input);
  if (filled instanceof FillError) throw new Error("the template fill refused; the template-fill gate names the beats");
  const found = filled.beats.filter((beat) => CHART_REFS.has(beat.ref) && colourOnlySeries(beat.ref, frameOf(beat.ref, beat.slots))).map((beat) => beat.id);
  return { pass: found.length === 0, detail: found.length === 0 ? "no chart tells its series apart by colour alone" : `series told apart by colour alone: ${found.join(", ")}` };
}
