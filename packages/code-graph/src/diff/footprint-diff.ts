import { parseSymbolId, symbolId } from "../extractors/ids.js";
import type { AliasChain } from "../identity/alias-chain.js";
import { aliasChain } from "../identity/store-identity.js";
import type { CodeGraphStore } from "../store.js";
import type { GraphNode } from "../types.js";
import { computeFootprints, type FootprintGraph, type FootprintOptions, type SymbolFootprint } from "./footprint.js";
import type { FootprintChange, FootprintChangeReason, FootprintDiff } from "./types.js";

export interface DiffFootprintsOptions extends FootprintOptions {
  fromSnapshotId: number;
  toSnapshotId: number;
}

type ResolveId = (id: string) => string;

const PART_REASONS = ["signature", "consumers", "coupling"] as const;

/**
 * Symbols whose documentable footprint differs between two snapshots. From-snapshot ids
 * follow the alias chain first, so a moved file reads as `renamed`, not a remove plus an add.
 */
export function diffFootprints(store: CodeGraphStore, options: DiffFootprintsOptions): FootprintDiff {
  const { fromSnapshotId, toSnapshotId } = options;
  const resolve = symbolAwareResolver(aliasChain(store, fromSnapshotId, toSnapshotId));
  const fromGraph = loadSymbolLayer(store, fromSnapshotId);
  const toGraph = loadSymbolLayer(store, toSnapshotId);
  const before = computeFootprints(remapGraph(fromGraph, resolve), options);
  const after = computeFootprints(toGraph, options);
  const previousIds = previousIdsOf(fromGraph.nodes, resolve);
  const changes = [
    ...changedOrAdded(after, before, previousIds),
    ...removed(before, after, previousIds, resolve),
  ].sort((a, b) => compare(a.symbolId, b.symbolId));
  const files = [...new Set(changes.map((c) => c.fileId))].sort(compare);
  return { fromSnapshotId, toSnapshotId, changes, files };
}

function loadSymbolLayer(store: CodeGraphStore, snapshotId: number): FootprintGraph {
  return {
    nodes: store.listNodes(snapshotId, { includeSymbols: true }).filter((n) => n.kind === "symbol"),
    edges: store.listEdges(snapshotId, { includeReferences: true }),
  };
}

// File renames alias only the file id, so a symbol under a moved file resolves through its file.
function symbolAwareResolver(aliases: Pick<AliasChain, "resolve">): ResolveId {
  return (id) => {
    const direct = aliases.resolve(id);
    if (direct !== id) return direct;
    const parsed = parseSymbolId(id);
    return parsed ? symbolId(aliases.resolve(parsed.fileId), parsed.name) : id;
  };
}

function remapGraph(graph: FootprintGraph, resolve: ResolveId): FootprintGraph {
  return {
    nodes: graph.nodes.map((n) => ({ ...n, id: resolve(n.id) })),
    edges: graph.edges.map((e) => ({ ...e, srcId: resolve(e.srcId), dstId: resolve(e.dstId) })),
  };
}

/** Resolved id to the original from-snapshot id, for symbols whose id moved. */
function previousIdsOf(nodes: readonly GraphNode[], resolve: ResolveId): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of nodes) {
    const id = resolve(node.id);
    if (id !== node.id) out.set(id, node.id);
  }
  return out;
}

function changedOrAdded(
  after: ReadonlyMap<string, SymbolFootprint>,
  before: ReadonlyMap<string, SymbolFootprint>,
  previousIds: ReadonlyMap<string, string>,
): FootprintChange[] {
  const out: FootprintChange[] = [];
  for (const [id, footprint] of after) {
    const prior = before.get(id);
    const previousId = previousIds.get(id);
    if (!prior) {
      out.push({ symbolId: id, status: "added", reasons: [], fileId: declaringFile(id) });
      continue;
    }
    const reasons = reasonsFor(prior, footprint, previousId !== undefined);
    if (reasons.length === 0) continue;
    out.push({ symbolId: id, ...(previousId ? { previousId } : {}), status: "changed", reasons, fileId: declaringFile(id) });
  }
  return out;
}

function reasonsFor(prior: SymbolFootprint, current: SymbolFootprint, renamed: boolean): FootprintChangeReason[] {
  const reasons: FootprintChangeReason[] = PART_REASONS.filter((part) => prior.parts[part] !== current.parts[part]);
  if (renamed) reasons.push("renamed");
  return reasons;
}

function removed(
  before: ReadonlyMap<string, SymbolFootprint>,
  after: ReadonlyMap<string, SymbolFootprint>,
  previousIds: ReadonlyMap<string, string>,
  resolve: ResolveId,
): FootprintChange[] {
  const out: FootprintChange[] = [];
  for (const id of before.keys()) {
    if (after.has(id)) continue;
    const fromId = previousIds.get(id) ?? id;
    out.push({ symbolId: fromId, status: "removed", reasons: [], fileId: resolve(declaringFile(fromId)) });
  }
  return out;
}

function declaringFile(id: string): string {
  return parseSymbolId(id)?.fileId ?? id;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
