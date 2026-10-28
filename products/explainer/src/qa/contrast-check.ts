import type { HeldFinding, InspectOptions } from "@titan-design/render-qa";
import { semanticColorsDark } from "@titan-design/react-ui/theme/tokens";
import { z } from "zod";
import { BEAT_SLOTS } from "../beat-slots.js";
import { scaleColours } from "../composition/beats/chart-frame.js";
import type { ContrastThresholds } from "./gate-profile.js";

/**
 * Text and chart-mark contrast against the gate profile's WCAG thresholds (CH-19; WCAG 1.4.3, 1.4.11). Chart marks are
 * computed from the slots' scale and the page's dark theme tokens, no pixels sampled. Text is the ratio render-qa's
 * in-page `low-contrast` rule computed from each run's styles; it records a run only under its own thresholds, which
 * are at least as strict as these, so every text run under these thresholds is among them.
 */

const MarkSchema = z.object({ beat: z.string(), mark: z.string(), colour: z.string(), ground: z.string(), ratio: z.number() });
const TextSchema = z.object({ beat: z.string(), text: z.string(), px: z.number(), ratio: z.number(), need: z.number() });

export const ContrastReportSchema = z.object({
  thresholds: z.object({ text: z.number(), largeText: z.number(), largeTextPx: z.number(), nonText: z.number() }),
  text: z.object({ below: z.array(TextSchema) }),
  marks: z.object({ checked: z.number().int().nonnegative(), below: z.array(MarkSchema) }),
  /** What could not be computed from colours and how it was judged instead. */
  fallbacks: z.array(z.string()),
});
type ContrastReport = z.infer<typeof ContrastReportSchema>;
type ChartMark = z.infer<typeof MarkSchema>;

const linear = (channel: number): number => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);

const luminance = (hex: string): number => {
  const channel = (at: number): number => linear(Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** WCAG contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type ChartSlots = z.infer<(typeof BEAT_SLOTS)["chart"]>;
type ThemeToken = keyof typeof semanticColorsDark;
interface MarkTokens {
  mark: ThemeToken;
  ground: ThemeToken;
}

/**
 * Each drawn chart kind's unscaled mark colour and the ground it sits on, as the stage CSS paints them: a bar fills
 * `.ex-bar-track` (examples.css), a line chart's column stands on the frame (beats.css `.beat-graph-bar`).
 */
const CHART_MARK_TOKENS: Partial<Record<ChartSlots["kind"], MarkTokens>> = {
  bar: { mark: "text-secondary", ground: "surface-raised" },
  line: { mark: "dataviz-categorical-0", ground: "background-base" },
};

interface TimelineBeat {
  id: string;
  kind: string;
  slots?: unknown;
}

function beatMarks(id: string, slots: ChartSlots, tokens: MarkTokens): ChartMark[] {
  const ground = semanticColorsDark[tokens.ground];
  const scaled = slots.scale ? scaleColours(slots.scale, slots.series.map((point) => point.value), slots.baseline ?? 0) : [];
  return slots.series.map((point, i) => {
    const colour = scaled[i] ?? semanticColorsDark[tokens.mark];
    return { beat: id, mark: point.id, colour, ground, ratio: contrastRatio(colour, ground) };
  });
}

/** Every drawn chart mark with its ratio; a chart kind the page does not draw is named as a fallback instead. */
function chartMarks(beats: readonly TimelineBeat[], fallbacks: string[]): ChartMark[] {
  return beats.flatMap((beat) => {
    if (beat.kind !== "chart") return [];
    const slots = BEAT_SLOTS.chart.safeParse(beat.slots);
    const tokens = slots.success ? CHART_MARK_TOKENS[slots.data.kind] : undefined;
    if (slots.success && tokens) return beatMarks(beat.id, slots.data, tokens);
    fallbacks.push(`${beat.id}: ${slots.success ? `chart kind ${slots.data.kind} is not drawn` : "its chart slots do not parse"}, so its marks were not checked`);
    return [];
  });
}

/** render-qa's measured text runs re-judged by WCAG's size rule; a run under the large-text size needs the text ratio. */
function textBelow(held: readonly HeldFinding[], thresholds: ContrastThresholds): ContrastReport["text"]["below"] {
  return held.flatMap(({ kind, beat, finding }) => {
    if (kind !== "low-contrast" || finding.ratio === undefined || finding.px === undefined) return [];
    const need = finding.px >= thresholds.largeTextPx ? thresholds.largeText : thresholds.text;
    return finding.ratio < need ? [{ beat, text: finding.text ?? "", px: finding.px, ratio: finding.ratio, need }] : [];
  });
}

const BOLD_FALLBACK = "text: render-qa reads no font weight, so bold text from 18.66 to 24 px is held to the normal-text ratio";

/** render-qa's in-page thresholds, which decide which text runs it records at all. */
type InPage = Pick<InspectOptions, "minContrast" | "largeContrast" | "largePx">;

/** Whether render-qa records every run these thresholds would fail: its ratios no lower, its large size no smaller. */
export const inPageCovers = (inPage: InPage, thresholds: ContrastThresholds): boolean =>
  inPage.minContrast >= thresholds.text && inPage.largeContrast >= thresholds.largeText && inPage.largePx >= thresholds.largeTextPx;

const LOOSE_FALLBACK = "text: render-qa's in-page thresholds are looser than these, so runs between the two go unseen";

/** The qa.json contrast section over the timeline's beats and every held finding, error or info. */
export function contrastReport(beats: readonly TimelineBeat[], held: readonly HeldFinding[], thresholds: ContrastThresholds, inPage: InPage): ContrastReport {
  const fallbacks = [BOLD_FALLBACK, ...(inPageCovers(inPage, thresholds) ? [] : [LOOSE_FALLBACK])];
  const marks = chartMarks(beats, fallbacks);
  return {
    thresholds: { ...thresholds },
    text: { below: textBelow(held, thresholds) },
    marks: { checked: marks.length, below: marks.filter((mark) => mark.ratio < thresholds.nonText) },
    fallbacks,
  };
}
