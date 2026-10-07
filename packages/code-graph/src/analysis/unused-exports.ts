import type { GraphEdge, GraphNode } from "../types.js";
import { keepNode, lookupMetric, type ReportContext } from "./graph-report-sections.js";
import type { UnusedExportRow } from "./graph-report-types.js";

/**
 * The set of files re-exported by a `barrel`-role node (1-hop `re-exports`
 * edges) — i.e. files whose exports form a package's public surface. An unused
 * export declared in one of these may still be consumed *externally* (by an npm
 * consumer of a published package), so it's flagged lower-confidence rather than
 * excluded. Transitive barrel chains are not followed (v1); a symbol behind two
 * barrels reads as internal.
 */
export function publicApiFiles(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Set<string> {
  const barrels = new Set(
    nodes.filter((n) => n.role === "barrel").map((n) => n.id),
  );
  const out = new Set<string>();
  for (const e of edges) {
    if (e.kind === "re-exports" && barrels.has(e.srcId)) out.add(e.dstId);
  }
  return out;
}

/**
 * Exported symbols (C-64 `attrs.exported`) with zero inbound `references` — an
 * export that nothing imports by name (utilization is barrel-resolved, C-53, so
 * an export used *through* a barrel reads > 0). Framed as "no reference found",
 * not "dead": it may be used only internally within its own file, or consumed
 * externally if the repo is a published library — hence the `publicApi` split.
 * Ranked by the export's own cognitive complexity (a complex unused export is
 * the most worth removing), scoped to kept (non-excluded) files.
 */
export function topUnusedExports(
  symbolNodes: readonly GraphNode[],
  publicApi: ReadonlySet<string>,
  ctx: ReportContext,
  limit: number,
): UnusedExportRow[] {
  const rows: UnusedExportRow[] = [];
  for (const n of symbolNodes) {
    if (n.kind !== "symbol" || n.attrs?.exported !== true) continue;
    if ((lookupMetric(ctx, "utilization", n.id) ?? 0) > 0) continue;
    const fileId = n.parentId;
    if (!fileId || !keepNode(ctx, fileId)) continue;
    rows.push({
      nodeId: n.id,
      name: n.name,
      fileId,
      cognitive: lookupMetric(ctx, "symbol_cognitive", n.id) ?? 0,
      loc: lookupMetric(ctx, "symbol_loc", n.id) ?? 0,
      publicApi: publicApi.has(fileId),
    });
  }
  rows.sort(
    (a, b) =>
      Number(a.publicApi) - Number(b.publicApi) ||
      b.cognitive - a.cognitive ||
      a.nodeId.localeCompare(b.nodeId),
  );
  return rows.slice(0, limit);
}
