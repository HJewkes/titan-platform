import type { GraphEdge, GraphMetric, GraphNode } from "./types.js";
import { edgeWeight, resolveBarrelEdges } from "./barrel-resolve.js";

interface DegreeCounts {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
}

/**
 * fan_in / fan_out are file/module *structural* coupling — how many modules a
 * file depends on, and vice versa. They count only `imports`/`re-exports`
 * edges; the per-symbol `references` layer (C-53) is a finer granularity and
 * must not inflate module degree (one references edge per imported *symbol*
 * would turn "depends on 3 modules" into "names 30 symbols").
 */
function isStructuralEdge(e: GraphEdge): boolean {
  return e.kind === "imports" || e.kind === "re-exports";
}

function countDegrees(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): DegreeCounts {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const n of nodes) {
    fanIn.set(n.id, 0);
    fanOut.set(n.id, 0);
  }
  for (const e of edges) {
    if (!isStructuralEdge(e)) continue;
    if (fanOut.has(e.srcId)) {
      fanOut.set(e.srcId, fanOut.get(e.srcId)! + 1);
    }
    if (fanIn.has(e.dstId)) {
      fanIn.set(e.dstId, fanIn.get(e.dstId)! + 1);
    }
  }
  return { fanIn, fanOut };
}

/**
 * Utilization: inbound edges weighted by their reference count (C-51's
 * `attrs.weight`), so it measures how heavily a file's exports are actually
 * *used*, not merely how many files name it. Computed over the
 * BARREL-RESOLVED edge set (C-53), so re-export plumbing is credited to the
 * files that do the work rather than to the `index.ts` hub everything routes
 * through. A pure barrel therefore reads utilization ~0 (fan_in still counts
 * its raw importers) — a clean re-export-hub signature. Deterministic over the
 * assembled edge set, so it stays correct under incremental reuse.
 */
function weightedInbound(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Map<string, number> {
  const util = new Map<string, number>();
  for (const n of nodes) util.set(n.id, 0);
  for (const e of resolveBarrelEdges(nodes, edges)) {
    if (util.has(e.dstId)) util.set(e.dstId, util.get(e.dstId)! + edgeWeight(e));
  }
  return util;
}

export function computeMetrics(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphMetric[] {
  const { fanIn, fanOut } = countDegrees(nodes, edges);
  const utilization = weightedInbound(nodes, edges);
  const out: GraphMetric[] = [];
  for (const n of nodes) {
    // Symbol nodes carry only utilization (how heavily the export is used).
    // fan_in/fan_out/instability are module-structural and don't apply — and
    // skipping them keeps the per-export layer from tripling the metric table.
    if (n.kind === "symbol") {
      out.push({ nodeId: n.id, name: "utilization", value: utilization.get(n.id) ?? 0, unit: "count" });
      continue;
    }
    const ci = fanIn.get(n.id) ?? 0;
    const co = fanOut.get(n.id) ?? 0;
    out.push({ nodeId: n.id, name: "fan_in", value: ci, unit: "count" });
    out.push({ nodeId: n.id, name: "fan_out", value: co, unit: "count" });
    out.push({ nodeId: n.id, name: "utilization", value: utilization.get(n.id) ?? 0, unit: "count" });
    if (ci + co > 0) {
      out.push({
        nodeId: n.id,
        name: "instability",
        value: co / (ci + co),
        unit: "ratio",
      });
    }
  }
  return out;
}
