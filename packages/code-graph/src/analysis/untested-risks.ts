import {
  hotspotScoreOf,
  keepNode,
  lookupMetric,
  type ReportContext,
} from "./graph-report-sections.js";
import type { UntestedRiskRow } from "./graph-report-types.js";

/**
 * Files that are load-bearing, complex, frequently changed and under-tested (C-63),
 * ranked by `hotspot × (1 − coverage/100)`. Requires an
 * ingested coverage overlay (`graph coverage`); with no coverage, the section is
 * empty (never a stale or assumed number — coverage is an overlay, not inferred).
 * A fully-covered hotspot (coverage 100) scores 0 and drops out.
 */
export function topUntestedRisks(
  ctx: ReportContext,
  limit: number,
): UntestedRiskRow[] {
  const rows: UntestedRiskRow[] = [];
  for (const node of ctx.nodes) {
    if (!keepNode(ctx, node.id)) continue;
    const coverage = lookupMetric(ctx, "coverage_pct", node.id);
    if (coverage === undefined || coverage >= 100) continue;
    const hotspot = hotspotScoreOf(ctx, node.id);
    const score = Math.round(hotspot * (1 - coverage / 100));
    if (score <= 0) continue;
    rows.push({ nodeId: node.id, coverage, hotspot, score });
  }
  rows.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  return rows.slice(0, limit);
}
