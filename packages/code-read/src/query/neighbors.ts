import type { CommandArgs, CommandResult } from "./contract.js";
import { refFor } from "./finding-rows.js";
import type { ModelEdge, ReadModel } from "./model.js";
import { columnFor } from "./rollup.js";
import { modelFor } from "./snapshot-ref.js";
import { invalidArgs, nodeNotFound, type ReadSource } from "./source.js";
import { treeFor, type Tree } from "./tree.js";

type NeighborsResult = CommandResult<"node.neighbors">;
type Neighbor = NeighborsResult["inbound"][number];

interface Adjacency {
  inbound: ReadonlyMap<string, readonly ModelEdge[]>;
  outbound: ReadonlyMap<string, readonly ModelEdge[]>;
}

const adjacencies = new WeakMap<ReadModel, Adjacency>();

function push(map: Map<string, ModelEdge[]>, key: string, edge: ModelEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

/** Edges by destination and by source, built once per model. */
export function adjacencyOf(model: ReadModel): Adjacency {
  let adjacency = adjacencies.get(model);
  if (!adjacency) {
    const inbound = new Map<string, ModelEdge[]>();
    const outbound = new Map<string, ModelEdge[]>();
    for (const edge of model.edges) {
      push(inbound, edge.dstId, edge);
      push(outbound, edge.srcId, edge);
    }
    adjacencies.set(model, (adjacency = { inbound, outbound }));
  }
  return adjacency;
}

export const weightOf = (edge: ModelEdge): number | null => (typeof edge.attrs.weight === "number" ? edge.attrs.weight : null);

function valueOf(model: ReadModel, tree: Tree, id: string, name: string): number | null {
  const node = tree.byId.get(id);
  if (node) return columnFor(model, tree, name).valueOf(node).value;
  return model.metrics.get(name)?.get(id) ?? null;
}

function toNeighbor(model: ReadModel, tree: Tree, edge: ModelEdge, otherId: string, metrics: readonly string[]): Neighbor {
  const neighbor: Neighbor = { node: refFor(model, otherId), kind: edge.kind, weight: weightOf(edge), values: {} };
  if (typeof edge.attrs.specifier === "string") neighbor.specifier = edge.attrs.specifier;
  for (const name of metrics) neighbor.values[name] = valueOf(model, tree, otherId, name);
  return neighbor;
}

// Heaviest first, unweighted last, then by neighbour id and kind, so equal weights page the same way every time.
function compareNeighbors(a: Neighbor, b: Neighbor): number {
  const [x, y] = [a.weight ?? -Infinity, b.weight ?? -Infinity];
  if (x !== y) return y - x;
  if (a.node.id !== b.node.id) return a.node.id < b.node.id ? -1 : 1;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

type EdgeFilter = (edge: ModelEdge) => boolean;

// The design's default: `references` is the symbol layer, noise on a file's list but a symbol's only edges.
function edgeFilter(kinds: readonly string[], nodeKind: string): EdgeFilter {
  if (kinds.length > 0) return (edge) => kinds.includes(edge.kind);
  return nodeKind === "symbol" ? () => true : (edge) => edge.kind !== "references";
}

interface Side {
  rows: Neighbor[];
  total: number;
}

interface Paging {
  keep: EdgeFilter;
  build: (edge: ModelEdge, otherId: string) => Neighbor;
  offset: number;
  limit: number;
}

function side(edges: readonly ModelEdge[] | undefined, other: (edge: ModelEdge) => string, p: Paging): Side {
  const all = (edges ?? []).filter(p.keep).map((e) => p.build(e, other(e))).sort(compareNeighbors);
  return { rows: all.slice(p.offset, p.offset + p.limit), total: all.length };
}

/** `node.neighbors`: a stored node's inbound and outbound edges, each side paged on its own. */
export function getNeighbors(source: ReadSource, args: CommandArgs<"node.neighbors">): NeighborsResult {
  const model = modelFor(source, args.snapshot);
  const tree = treeFor(model);
  const node = model.nodeById.get(args.id);
  if (!node && tree.byId.has(args.id)) throw invalidArgs(`${args.id} is synthesized; node.neighbors needs a stored node`);
  if (!node) throw nodeNotFound(args.id, model.snapshot.id);
  const { inbound, outbound } = adjacencyOf(model);
  const metrics = [...new Set(args.metrics)];
  const paging: Paging = {
    keep: edgeFilter(args.edge_kinds, node.kind),
    build: (e, id) => toNeighbor(model, tree, e, id, metrics),
    offset: args.offset,
    limit: args.limit,
  };
  const none: Side = { rows: [], total: 0 };
  const ins = args.direction === "out" ? none : side(inbound.get(node.id), (e) => e.srcId, paging);
  const outs = args.direction === "in" ? none : side(outbound.get(node.id), (e) => e.dstId, paging);
  return {
    snapshotId: model.snapshot.id,
    node: refFor(model, node.id),
    inbound: ins.rows,
    outbound: outs.rows,
    total: { inbound: ins.total, outbound: outs.total },
  };
}
