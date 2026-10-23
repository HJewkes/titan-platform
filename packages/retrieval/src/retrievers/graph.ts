import type { EdgeTable } from "@titan-design/store-sqlite";
import type { Hit, RetrieveOptions, Retriever } from "../types.js";
import { walkGraph, type WalkGraph, type WalkNeighbour } from "./walk.js";

export interface GraphRetrieverOptions {
  name?: string;
  /** Only follow these relations; all when omitted. */
  relations?: string[];
  /** How far to walk from the seeds. */
  hops?: number;
  /** Follow edges in both directions (default) or only source to target. */
  direction?: "both" | "out";
  /**
   * A non-seed node with at least this many followed edges is returned but not expanded. Uncapped
   * when omitted: the edge table cannot list every node's degree, so pass
   * `defaultHubDegree(degrees)` from your own counts to get the walk's p99 default.
   */
  hubDegree?: number;
  /** Stop once this many neighbours have been reached (default unlimited). */
  maxNodes?: number;
}

/**
 * Expand a set of seed ids through the edge table, ranking neighbours by hop
 * distance then discovery order. Wrap it with `seededBy` so the seeds come
 * from another retriever's top results for the same query.
 */
export function expandGraph(edges: EdgeTable, seeds: string[], options: GraphRetrieverOptions = {}): Hit[] {
  const steps = walkGraph(edgeTableGraph(edges, options), seeds, {
    hops: options.hops,
    hubDegree: options.hubDegree ?? Infinity,
    maxNodes: options.maxNodes,
  });
  return steps.map(({ id, hop, via, relation }, i) => ({ id, rank: i + 1, payload: { hop, via, relation } }));
}

/** The edge table as a walk adjacency, restricted to the followed relations and direction. */
function edgeTableGraph(edges: EdgeTable, options: GraphRetrieverOptions): WalkGraph {
  const allowed = options.relations ? new Set(options.relations) : null;
  const neighbours = (id: string): WalkNeighbour[] => {
    const out = edges.from(id).map((e) => ({ id: e.targetRef, relation: e.relation }));
    const all = options.direction === "out" ? out : out.concat(edges.to(id).map((e) => ({ id: e.sourceRef, relation: e.relation })));
    return allowed ? all.filter((n) => allowed.has(n.relation)) : all;
  };
  return { neighbours, degree: (id) => neighbours(id).length };
}

/** A graph retriever whose seeds are the top results of another retriever for the same query. */
export function graphRetriever(edges: EdgeTable, seededBy: Retriever, options: GraphRetrieverOptions & { seedLimit?: number } = {}): Retriever {
  return {
    name: options.name ?? "graph",
    async retrieve(query: string, retrieveOptions: RetrieveOptions): Promise<Hit[]> {
      const seeds = await seededBy.retrieve(query, { ...retrieveOptions, limit: options.seedLimit ?? 5 });
      return expandGraph(edges, seeds.map((s) => s.id), options).slice(0, retrieveOptions.limit);
    },
  };
}
