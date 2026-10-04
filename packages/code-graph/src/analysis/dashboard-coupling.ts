import type { NodeMetrics, SymbolUtil } from "./dashboard-node-metrics.js";
import type { SymbolCouplingPayload } from "./dashboard-symbol-coupling.js";

/**
 * Snapshot-level (window-independent) derived data: which file pairs are joined
 * by a static import edge, and each node's PageRank centrality. Computed once
 * per snapshot from a single db open, shared across all window payloads.
 */
export interface SnapshotContext {
  linkedPairs: ReadonlySet<string>;
  centrality: ReadonlyMap<string, number>;
  /**
   * Ids of files that participate in at least one *internal* (repo-to-repo)
   * import/re-export edge. A file missing here has no resolved imports in the
   * graph — either it isn't indexed, or its imports couldn't be resolved (e.g. a
   * dir outside the tsconfig project, whose relative specifiers resolve to junk).
   * Either way the import evidence is absent, so a co-change touching it can't be
   * called hidden-vs-import-backed; it's "unverifiable", not "hidden".
   */
  connectedNodes: ReadonlySet<string>;
  /** Per-node structural metrics (loc, cognitive/cyclomatic max, nesting, fan) for the Dossier. */
  metrics: ReadonlyMap<string, NodeMetrics>;
  /** Per-export utilization (C-53), for the Dossier "hot exports" list and the blast-radius section. */
  symbols: readonly SymbolUtil[];
  /** Inbound `references` count per symbol id (C-59): how many files consume each export. */
  consumersBySymbol: ReadonlyMap<string, number>;
  /** Symbol-level coupling slices (C-60): co-imported pairs + per-symbol consumers. */
  symbolCoupling?: SymbolCouplingPayload;
}

export type CouplingClass = { hidden: boolean; unindexed: boolean };

/**
 * Classify a co-changed pair against the static import graph:
 * - unindexed: an endpoint has no resolved internal imports → can't tell (not hidden).
 * - hidden: both connected, but no import/re-export edge joins them → the signal.
 * - expected: both connected and import-backed → usually fine.
 */
export function classifyCoupling(
  a: string,
  b: string,
  ctx: SnapshotContext,
): CouplingClass {
  const unindexed = !ctx.connectedNodes.has(a) || !ctx.connectedNodes.has(b);
  if (unindexed) return { hidden: false, unindexed: true };
  return { hidden: !ctx.linkedPairs.has(pairKey(a, b)), unindexed: false };
}

/** Order-independent key for an undirected file pair (JSON tuple; no in-band separator). */
export function pairKey(a: string, b: string): string {
  return a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
}
