import { canonicalEdgeKind } from "../aliases.js";
import {
  computeSymbolConsumers,
  computeSymbolCoupling,
  type ReferenceEdgeLite,
} from "../analysis/symbol-coupling.js";
import { hashText } from "../check/finding-store.js";
import type { GraphEdge, GraphNode } from "../types.js";

/**
 * A symbol's documentable footprint (C-75): structural inputs only, so a moved declaration,
 * a churn window or a centrality shift never reads as a change.
 */
export interface FootprintParts {
  /** Hash of `{name, exported, signature, purpose}`; no span. */
  signature: string;
  /** Hash of the sorted distinct file ids that reference the symbol. */
  consumers: string;
  /** Hash of the sorted co-import partner symbol ids at or above `minCoImports`. */
  coupling: string;
}

export interface SymbolFootprint {
  symbolId: string;
  parts: FootprintParts;
  /** Hash of the three part hashes. */
  hash: string;
}

export interface FootprintGraph {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}

export interface FootprintOptions {
  /** Drop a referencing file from consumers and co-import coupling, e.g. test files. Default keeps all. */
  ignoreConsumer?: (fileId: string) => boolean;
  /** Co-import threshold for a coupling partner. Default 2. */
  minCoImports?: number;
}

/** A doc target: the default unit is one file holding its symbols. */
export interface FootprintUnit {
  unitId: string;
  symbolIds: readonly string[];
}

const DEFAULT_MIN_CO_IMPORTS = 2;

/** Footprint of every symbol node in the graph, keyed by symbol id. */
export function computeFootprints(
  graph: FootprintGraph,
  options: FootprintOptions = {},
): Map<string, SymbolFootprint> {
  const edges = referenceEdges(graph.edges, options.ignoreConsumer);
  const consumers = consumersBySymbol(edges);
  const partners = partnersBySymbol(edges, options.minCoImports ?? DEFAULT_MIN_CO_IMPORTS);
  const out = new Map<string, SymbolFootprint>();
  for (const node of graph.nodes) {
    if (node.kind !== "symbol") continue;
    const parts: FootprintParts = {
      signature: hashJson(signatureOf(node)),
      consumers: hashJson(consumers.get(node.id) ?? []),
      coupling: hashJson(partners.get(node.id) ?? []),
    };
    const hash = hashJson([parts.signature, parts.consumers, parts.coupling]);
    out.set(node.id, { symbolId: node.id, parts, hash });
  }
  return out;
}

/**
 * Order-independent hash of a unit's `[symbolId, footprint.hash]` pairs. A member with no
 * footprint hashes as null, so a symbol that disappears still changes the set.
 */
export function symbolSetHash(
  unit: FootprintUnit,
  footprints: ReadonlyMap<string, SymbolFootprint>,
): string {
  const pairs = [...new Set(unit.symbolIds)]
    .sort()
    .map((id) => [id, footprints.get(id)?.hash ?? null]);
  return hashJson(pairs);
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function signatureOf(node: GraphNode): unknown {
  const attrs = node.attrs ?? {};
  return {
    name: node.name,
    exported: attrs.exported === true,
    signature: typeof attrs.signature === "string" ? attrs.signature : null,
    purpose: typeof attrs.purpose === "string" ? attrs.purpose : null,
  };
}

function referenceEdges(
  edges: readonly GraphEdge[],
  ignoreConsumer: FootprintOptions["ignoreConsumer"],
): ReferenceEdgeLite[] {
  return edges.filter(
    (e) => canonicalEdgeKind(e.kind) === "references" && !ignoreConsumer?.(e.srcId),
  );
}

function consumersBySymbol(edges: readonly ReferenceEdgeLite[]): Map<string, string[]> {
  return new Map(computeSymbolConsumers(edges).map((c) => [c.symbolId, c.consumers]));
}

function partnersBySymbol(
  edges: readonly ReferenceEdgeLite[],
  minCoImports: number,
): Map<string, string[]> {
  const partners = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    const set = partners.get(from) ?? new Set<string>();
    set.add(to);
    partners.set(from, set);
  };
  for (const pair of computeSymbolCoupling(edges, { minCoImports })) {
    add(pair.aId, pair.bId);
    add(pair.bId, pair.aId);
  }
  return new Map([...partners].map(([id, set]) => [id, [...set].sort()]));
}
