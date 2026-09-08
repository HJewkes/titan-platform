import type { GraphEdge, GraphNode } from "./types.js";

/** Edge weight (C-51 reference count), floored at 1 for unweighted edges. */
export function edgeWeight(e: GraphEdge): number {
  const w = (e.attrs as { weight?: number } | undefined)?.weight;
  return typeof w === "number" && w > 0 ? w : 1;
}

/**
 * Drop `references` edges (C-53) whose target `symbol` node doesn't exist — an
 * aliased re-export chain, or a barrel that changed under a reused file, can
 * resolve a name to an origin that doesn't declare it. Only `references` can
 * dangle (imports/re-exports resolve to always-emitted file/external nodes);
 * metrics already guard unknown ids, so this just keeps the persisted edge set
 * clean. Mutates `edges` in place.
 */
export function pruneDanglingReferences(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): void {
  for (const [key, edge] of edges) {
    if (edge.kind === "references" && !nodes.has(edge.dstId)) edges.delete(key);
  }
}

/**
 * Resolve edges that land on a barrel (`role="barrel"` — a bare `index.*`
 * re-export file) onto the files the barrel actually re-exports from, so
 * downstream signals measure the real dependency surface instead of the
 * re-export plumbing. A cross-package `import … from "@codewatch/graph"`
 * resolves to the barrel; without this every such import piles onto the barrel
 * as an artificial hub while the module that truly does the work is
 * under-credited.
 *
 * An inbound edge `F → B` (weight w) is split across B's outbound re-export
 * targets `t_i` in proportion to each target's re-export weight `r_i` (C-51:
 * the count of names B forwards from `t_i`). This CONSERVES w — no magnitude
 * inflation, unlike a uniform fan-out that turns one import into N edges — and
 * attributes it by how much of the barrel each target supplies. Resolution
 * recurses through barrel chains (a barrel re-exporting a barrel) with a
 * visited guard against re-export cycles; a barrel with no resolvable
 * re-exports is left as its own target so the dependency is never dropped.
 *
 * Pure over the assembled node/edge set, so it is deterministic regardless of
 * how much of an incremental index was reused.
 */
export function resolveBarrelEdges(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphEdge[] {
  const barrels = new Set<string>();
  for (const n of nodes) if (n.role === "barrel") barrels.add(n.id);
  if (barrels.size === 0) return [...edges];

  // Each barrel's outbound forwarding edges (re-exports, and any import it then
  // re-exports), keyed by barrel id, as {target, weight} to split inbound by.
  // A `references` edge is per-symbol *usage*, not re-export plumbing (a pure
  // barrel emits none — it only `export … from`s), so it's excluded from the
  // forwarding basis and kept as a real edge below (C-68).
  const forwards = new Map<string, { dst: string; weight: number }[]>();
  for (const e of edges) {
    if (!barrels.has(e.srcId) || e.kind === "references") continue;
    const arr = forwards.get(e.srcId) ?? [];
    arr.push({ dst: e.dstId, weight: edgeWeight(e) });
    forwards.set(e.srcId, arr);
  }

  const cache = new Map<string, Map<string, number>>();
  /** Distribution of a target over real (non-barrel) files: realId → fraction (sums to 1). */
  function resolve(id: string, seen: ReadonlySet<string>): Map<string, number> {
    if (!barrels.has(id)) return new Map([[id, 1]]);
    const cached = cache.get(id);
    if (cached) return cached;
    const targets = forwards.get(id);
    const total = targets?.reduce((s, t) => s + t.weight, 0) ?? 0;
    // Dead-end barrel (forwards nothing resolvable) or a cycle: keep as itself.
    if (!targets || total === 0 || seen.has(id)) return new Map([[id, 1]]);
    const out = new Map<string, number>();
    const nextSeen = new Set(seen).add(id);
    for (const t of targets) {
      const share = t.weight / total;
      for (const [real, frac] of resolve(t.dst, nextSeen)) {
        out.set(real, (out.get(real) ?? 0) + share * frac);
      }
    }
    cache.set(id, out);
    return out;
  }

  const resolved: GraphEdge[] = [];
  for (const e of edges) {
    // A barrel's own outbound import/re-export edges are plumbing — captured by
    // resolving its inbound edges to targets — so drop them to avoid
    // double-crediting. A `references` edge is genuine usage (e.g. a composition
    // root that the role classifier labels `barrel` but which actually consumes
    // a symbol via `const { runX } = await import(...)`, C-68), so keep it.
    if (barrels.has(e.srcId) && e.kind !== "references") continue;
    if (!barrels.has(e.dstId)) {
      resolved.push(e);
      continue;
    }
    const w = edgeWeight(e);
    for (const [real, frac] of resolve(e.dstId, new Set())) {
      if (real === e.srcId) continue; // a barrel that circles back to the importer
      resolved.push({
        ...e,
        dstId: real,
        attrs: { ...(e.attrs as object), weight: w * frac },
      });
    }
  }
  return resolved;
}
