import { median, p90 } from "./stage-times.js";

/** One stored round as the re-review read needs it; `at` is its verdict time, or its request time when it has none. */
export interface RereviewInput {
  cause: string | null;
  shape: string | null;
  scoped: number | null;
  at: number;
  usd: number | null;
  tokens: number | null;
}

interface Spread {
  p50: number | null;
  p90: number | null;
  total: number;
}

interface FixRoundCut {
  n: number;
  unpriced: number;
  usd: Spread;
  tokens: Spread;
}

/** Fix rounds before the cutoff, after it, and after it split by whether the brief was scoped to the fix diff. */
interface ShapeSplit {
  before: FixRoundCut;
  after: FixRoundCut;
  afterScoped: FixRoundCut;
  afterFull: FixRoundCut;
}

export interface Rereview {
  /** ISO instant; null when no round was scoped and no cutoff was given, so every fix round is `before`. */
  cutoff: string | null;
  cutoffFrom: "since-scoped" | "first-scoped" | "none";
  byShape: Record<string, ShapeSplit>;
}

const FIX_ROUND = "fix-round";

/** The bucket a cause reports under: a first review, a fix round, D8's convergence review, or any other re-review. */
export function causeBucket(cause: string | null): string {
  if (cause === null) return "unknown";
  return cause === "first" || cause === FIX_ROUND || cause === "convergence" ? cause : "other";
}

function spread(values: readonly (number | null)[], round: (value: number) => number): Spread {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return { p50: null, p90: null, total: 0 };
  return { p50: round(median(sorted)), p90: round(p90(sorted)), total: round(sorted.reduce((sum, value) => sum + value, 0)) };
}

const money = (value: number): number => Math.round(value * 1e6) / 1e6;

function fixRoundCut(rows: readonly RereviewInput[]): FixRoundCut {
  return { n: rows.length, unpriced: rows.filter((row) => row.usd === null).length, usd: spread(rows.map((row) => row.usd), money), tokens: spread(rows.map((row) => row.tokens), Math.round) };
}

function splitAt(rows: readonly RereviewInput[], cutoff: number | null): ShapeSplit {
  const after = cutoff === null ? [] : rows.filter((row) => row.at >= cutoff);
  return {
    before: fixRoundCut(cutoff === null ? rows : rows.filter((row) => row.at < cutoff)),
    after: fixRoundCut(after),
    afterScoped: fixRoundCut(after.filter((row) => row.scoped === 1)),
    afterFull: fixRoundCut(after.filter((row) => row.scoped !== 1)),
  };
}

/**
 * Fix-round cost per shape, before and after the cutoff: `sinceScoped` when given, else the first scoped round's time, since
 * scoping turns on for every repo at once. A round at the cutoff counts as after.
 */
export function rereviewOf(rows: readonly RereviewInput[], sinceScoped: number | undefined): Rereview {
  const firstScoped = rows.filter((row) => row.scoped === 1).reduce<number | null>((min, row) => (min === null || row.at < min ? row.at : min), null);
  const cutoff = sinceScoped ?? firstScoped;
  const fixRounds = rows.filter((row) => row.cause === FIX_ROUND);
  const shapes = [...new Set(fixRounds.map((row) => row.shape ?? "unknown"))].sort();
  return {
    cutoff: cutoff === null ? null : new Date(cutoff).toISOString(),
    cutoffFrom: sinceScoped !== undefined ? "since-scoped" : firstScoped !== null ? "first-scoped" : "none",
    byShape: Object.fromEntries(shapes.map((shape) => [shape, splitAt(fixRounds.filter((row) => (row.shape ?? "unknown") === shape), cutoff)])),
  };
}

const usdText = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(2)}`);
const tokenText = (value: number | null): string => (value === null ? "-" : String(value));
const cutLine = (shape: string, label: string, c: FixRoundCut): string =>
  `  ${shape}  ${label.padEnd(12)} n ${c.n}  usd p50 ${usdText(c.usd.p50)} p90 ${usdText(c.usd.p90)} total ${usdText(c.usd.total)}  tokens p50 ${tokenText(c.tokens.p50)} p90 ${tokenText(c.tokens.p90)}`;

/** Text mode: one line per shape and side of the cutoff; nothing when the range has no fix round. */
export function rereviewLines(rereview: Rereview): string[] {
  const shapes = Object.entries(rereview.byShape);
  if (shapes.length === 0) return [];
  const title = rereview.cutoff === null ? "fix-round re-reviews (no scoped round yet):" : `fix-round re-reviews, cutoff ${rereview.cutoff} (${rereview.cutoffFrom}):`;
  const lines = shapes.flatMap(([shape, split]) => [
    cutLine(shape, "before", split.before),
    ...(rereview.cutoff === null ? [] : [cutLine(shape, "after", split.after), cutLine(shape, "after scoped", split.afterScoped), cutLine(shape, "after full", split.afterFull)]),
  ]);
  return [title, ...lines];
}
