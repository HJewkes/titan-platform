import { keepNode, lookupMetric, type ReportContext } from "./graph-report-sections.js";
import type { GrowthRiskRow } from "./graph-report-types.js";

const LOOP_SHAPES: Record<number, string> = { 2: "quadratic-shaped", 3: "cubic-shaped" };

/** A loop-nesting depth's scaling-smell label — a shape, never a proven bound. */
function loopShape(depth: number): string {
  return LOOP_SHAPES[depth] ?? `${depth}-deep loop nesting`;
}

/** The scaling smells a file exhibits, in reading order (deep loops → recursion → search). */
function fileSmells(ctx: ReportContext, nodeId: string): string[] {
  const smells: string[] = [];
  const depth = lookupMetric(ctx, "loop_depth", nodeId) ?? 0;
  if (depth >= 2) smells.push(`${loopShape(depth)} loop nesting`);
  const rec = lookupMetric(ctx, "recursive_functions", nodeId) ?? 0;
  if (rec > 0) smells.push(`${rec} recursive function${rec === 1 ? "" : "s"}`);
  const search = lookupMetric(ctx, "search_in_loop", nodeId) ?? 0;
  if (search > 0) smells.push(`${search} linear search${search === 1 ? "" : "es"} in loops`);
  return smells;
}

/**
 * Files carrying a structural scaling smell (C-66): deep loop nesting, direct
 * recursion, or a linear-scan method call inside a loop. A HEURISTIC, not Big-O:
 * depth-2 loops over two different collections are linear, `.includes` on a `Set`
 * is O(1), and recursion may be well-bounded. Ranked by loop depth, then smell
 * count.
 */
export function topGrowthRisks(
  ctx: ReportContext,
  limit: number,
): GrowthRiskRow[] {
  const rows: GrowthRiskRow[] = [];
  for (const node of ctx.nodes) {
    if (!keepNode(ctx, node.id)) continue;
    const smells = fileSmells(ctx, node.id);
    if (smells.length === 0) continue;
    rows.push({
      nodeId: node.id,
      loopDepth: lookupMetric(ctx, "loop_depth", node.id) ?? 0,
      smells,
    });
  }
  rows.sort(
    (a, b) =>
      b.loopDepth - a.loopDepth ||
      b.smells.length - a.smells.length ||
      a.nodeId.localeCompare(b.nodeId),
  );
  return rows.slice(0, limit);
}
