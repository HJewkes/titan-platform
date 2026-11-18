import { z } from "zod";
import e1Expected from "./e1-expected.json" with { type: "json" };

/** Percentage points for a share, percent of the expected value for a count, or no slack at all. */
const Tolerance = z.union([z.object({ pp: z.number().nonnegative() }), z.object({ pct: z.number().nonnegative() }), z.object({ exact: z.literal(true) })]);
export type Tolerance = z.infer<typeof Tolerance>;

const week = z.string().regex(/^\d{4}-W\d{2}$/);

/** One transcribed figure. Shares are percentages (0-100); counts are plain numbers. */
const Figure = z.discriminatedUnion("metric", [
  z.object({ metric: z.enum(["tasks", "merged-share", "fix-rounds-zero-share", "fix-rounds-3plus-share", "reverted", "follow-ups-filed", "follow-up-sources", "sample-in-population"]) }),
  z.object({ metric: z.literal("class-share"), class: z.enum(["product", "upkeep", "mixed"]) }),
  z.object({ metric: z.literal("brief-share"), brief: z.enum(["restates", "pointer", "diverges"]) }),
  z.object({ metric: z.enum(["week-picks", "week-product-share", "week-filed-1d-share", "week-self-share", "week-owner-share", "week-rule-topk-share"]), week }),
  z.object({ metric: z.literal("dispatch-or-decision-share"), seat: z.string().min(1).optional() }),
]);
type FigureShape = z.infer<typeof Figure>;
export type ExpectedFigure = FigureShape & { expected: number; tolerance: Tolerance };

const ExpectedFile = z.object({
  source: z.string(),
  window: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  /** Named dispatcher sets; a population restricts the rows to tasks one of them dispatched first. */
  populations: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  /** Source labels the hand audit counted as self-generated work. */
  selfSources: z.array(z.string().min(1)),
  figures: z.array(z.intersection(Figure, z.object({ expected: z.number(), tolerance: Tolerance }))).min(1),
});
export type ExpectedFile = z.infer<typeof ExpectedFile>;

export function parseExpected(raw: unknown): ExpectedFile {
  return ExpectedFile.parse(raw);
}

/** The E1 figures (2026-11-12 hand audit, sections 1-3) with the plan's tolerance table. */
export function e1ExpectedFile(): ExpectedFile {
  return parseExpected(e1Expected);
}

/** A figure's row label, as the pass/miss table prints it. */
export function figureLabel(figure: FigureShape): string {
  if ("class" in figure) return `${figure.metric} ${figure.class}`;
  if ("brief" in figure) return `${figure.metric} ${figure.brief}`;
  if ("week" in figure) return `${figure.metric} ${figure.week}`;
  if ("seat" in figure && figure.seat !== undefined) return `${figure.metric} ${figure.seat}`;
  return figure.metric;
}
