import type { CodeGraphStore } from "../store.js";
import { computePageRank, type PageRankOptions, type PageRankResult } from "./pagerank.js";
import { computeRelevance, type RelevanceOptions } from "./relevance.js";
import {
  computeSymbolConsumers,
  computeSymbolCoupling,
  type ReferenceEdgeLite,
  type SymbolConsumers,
  type SymbolCouplingOptions,
  type SymbolCouplingPair,
} from "./symbol-coupling.js";

/**
 * PageRank over one snapshot's file-level graph (symbol nodes and `references`
 * edges excluded, as codewatch's `graph relevant` reads it). Pass
 * `personalization` to seed the walk toward target node ids.
 */
export function snapshotPageRank(
  store: CodeGraphStore,
  snapshotId: number,
  options: PageRankOptions = {},
): PageRankResult {
  return computePageRank(store.listNodes(snapshotId), store.listEdges(snapshotId), options);
}

/** Relevance of every file-level node to `seedIds`, as codewatch's `graph context` computes it. */
export function snapshotRelevance(
  store: CodeGraphStore,
  snapshotId: number,
  seedIds: readonly string[],
  options: RelevanceOptions = {},
): Map<string, number> {
  return computeRelevance(store.listNodes(snapshotId), store.listEdges(snapshotId), seedIds, options);
}

/** The snapshot's `references` edges: importing file to imported symbol. */
export function snapshotReferenceEdges(store: CodeGraphStore, snapshotId: number): ReferenceEdgeLite[] {
  return store
    .listEdges(snapshotId, { includeReferences: true })
    .filter((e) => e.kind === "references")
    .map((e) => ({ srcId: e.srcId, dstId: e.dstId }));
}

/** Per-symbol consumer files for one snapshot. */
export function snapshotSymbolConsumers(store: CodeGraphStore, snapshotId: number): SymbolConsumers[] {
  return computeSymbolConsumers(snapshotReferenceEdges(store, snapshotId));
}

/** Co-import symbol coupling pairs for one snapshot. */
export function snapshotSymbolCoupling(
  store: CodeGraphStore,
  snapshotId: number,
  options: SymbolCouplingOptions = {},
): SymbolCouplingPair[] {
  return computeSymbolCoupling(snapshotReferenceEdges(store, snapshotId), options);
}
