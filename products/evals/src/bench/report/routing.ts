import type { Cell } from "./load.js";
import { mean, pairedDiff } from "./stats.js";
import type { Metric, TrackContext } from "./tables.js";

/** Section 9's thinness rule: below this many complete blocks a cell keeps production. */
export const MIN_ROUTING_BLOCKS = 8;
/** A CI on the pick-vs-production difference wider than this either side of its centre keeps production. */
export const MAX_ROUTING_HALF_WIDTH = 0.25;
/** Non-inferiority margins against the best arm, on each track's primary per-case score. */
export const ROUTING_MARGIN = { review: 0.05, implement: 0.1, plan: 0.1 } as const;
export const TOO_THIN = "too thin, keep production";
export const NOT_MEASURED = "not measured";
const NO_RUN = "no run";
/** I measures S and M non-test-only tasks only (section 1, "Excluded by budget"). */
const UNMEASURED_SIZES: ReadonlySet<string> = new Set(["L"]);
const UNMEASURED_KINDS: ReadonlySet<string> = new Set(["test-only"]);
const KINDS = ["correctness", "feature", "refactor", "security", "test-only"];
const SIZES = ["S", "M", "L"];
export const ANY_SIZE = "any";

interface RoutingPick {
  text: string;
  pick: string | null;
  n: number;
  delta: number | null;
  lower: number | null;
  upper: number | null;
}

export interface RoutingRow {
  kind: string;
  size: string;
  review: RoutingPick | null;
  implement: RoutingPick | null;
  plan: RoutingPick | null;
}

export interface RoutedTrack {
  ctx: TrackContext;
  metric: Metric;
  margin: number;
}

const blank = (text: string): RoutingPick => ({ text, pick: null, n: 0, delta: null, lower: null, upper: null });

/** Per complete case in the cell, every core arm's score; a case any arm leaves unscored is dropped for all. */
function scoreMatrix(routed: RoutedTrack, inCell: (cell: Cell) => boolean): Map<string, number[]> {
  const { ctx, metric } = routed;
  const production = ctx.index.get(ctx.blocks.production);
  const arms = ctx.blocks.coreArms;
  const rows = ctx.blocks.complete.flatMap((hash) => {
    const anchor = production?.get(hash);
    if (anchor === undefined || !inCell(anchor)) return [];
    const scores = arms.map((arm) => {
      const cell = ctx.index.get(arm)?.get(hash);
      return cell === undefined ? null : metric(cell);
    });
    return scores.every((score): score is number => score !== null) ? [scores] : [];
  });
  return new Map(arms.map((arm, column) => [arm, rows.map((row) => row[column] ?? 0)]));
}

function meanUsd(ctx: TrackContext, arm: string): number {
  return mean([...(ctx.index.get(arm)?.values() ?? [])].filter((cell) => ctx.blocks.complete.includes(cell.caseHash)).map((cell) => cell.listUsd)) ?? Number.POSITIVE_INFINITY;
}

/** The cheapest arm whose CI against the best arm stays inside the margin, with its evidence against production. */
export function routeCell(routed: RoutedTrack, inCell: (cell: Cell) => boolean, label: string): RoutingPick {
  const matrix = scoreMatrix(routed, inCell);
  const production = routed.ctx.blocks.production;
  const productionScores = matrix.get(production) ?? [];
  const n = productionScores.length;
  if (n === 0) return { ...blank(TOO_THIN), n };
  const ranked = [...matrix.entries()].map(([arm, scores]) => ({ arm, scores, rate: mean(scores) ?? 0 })).sort((a, b) => b.rate - a.rate);
  const best = ranked[0] ?? { arm: production, scores: productionScores, rate: 0 };
  const inside = ranked.filter(({ arm, scores }) => arm === best.arm || (pairedDiff(scores, best.scores, `route:${label}:${arm}~best`)?.lower ?? -1) >= -routed.margin);
  const pick = inside.map(({ arm }) => ({ arm, usd: meanUsd(routed.ctx, arm) })).sort((a, b) => a.usd - b.usd)[0]?.arm ?? production;
  const evidence = pairedDiff(matrix.get(pick) ?? [], productionScores, `route:${label}:${pick}~production`);
  const thin = n < MIN_ROUTING_BLOCKS || evidence === null || (evidence.upper - evidence.lower) / 2 > MAX_ROUTING_HALF_WIDTH;
  return { text: thin ? TOO_THIN : pick, pick: thin ? null : pick, n, delta: evidence?.delta ?? null, lower: evidence?.lower ?? null, upper: evidence?.upper ?? null };
}

interface RoutingInput {
  review?: RoutedTrack;
  implement?: RoutedTrack;
  plan?: RoutedTrack;
}

const ofKind = (kind: string) => (cell: Cell) => cell.stratum.kind === kind;

function seenKinds(input: RoutingInput): string[] {
  const cellsOf = (routed: RoutedTrack | undefined): Cell[] => [...(routed?.ctx.index.values() ?? [])].flatMap((byCase) => [...byCase.values()]);
  const seen = [input.review, input.implement, input.plan].flatMap(cellsOf).map((cell) => cell.stratum.kind ?? "?");
  return [...new Set([...KINDS, ...seen.sort()])];
}

function implementCell(input: RoutingInput, kind: string, size: string): RoutingPick {
  if (UNMEASURED_KINDS.has(kind) || UNMEASURED_SIZES.has(size)) return blank(NOT_MEASURED);
  if (input.implement === undefined) return blank(NO_RUN);
  return routeCell(input.implement, (cell) => cell.stratum.kind === kind && cell.stratum.size === size, `i:${kind}:${size}`);
}

/** One "any"-size row per kind for review and plan, then the kind's S, M and L rows for implement. */
export function routingTable(input: RoutingInput): RoutingRow[] {
  return seenKinds(input).flatMap((kind) => [
    {
      kind,
      size: ANY_SIZE,
      review: input.review === undefined ? blank(NO_RUN) : routeCell(input.review, ofKind(kind), `r:${kind}`),
      implement: null,
      plan: input.plan === undefined ? blank(NO_RUN) : routeCell(input.plan, ofKind(kind), `p:${kind}`),
    },
    ...SIZES.map((size) => ({ kind, size, review: null, implement: implementCell(input, kind, size), plan: null })),
  ]);
}
