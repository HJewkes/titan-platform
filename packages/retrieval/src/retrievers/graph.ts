import type { EdgeTable } from "@titan-design/store-sqlite";
import type { Hit, RetrieveOptions, Retriever } from "../types.js";

export interface GraphRetrieverOptions {
  name?: string;
  /** Only follow these relations; all when omitted. */
  relations?: string[];
  /** How far to walk from the seeds. */
  hops?: number;
  /** Follow edges in both directions (default) or only source to target. */
  direction?: "both" | "out";
}

/**
 * Expand a set of seed ids through the edge table, ranking neighbours by hop
 * distance then discovery order. Wrap it with `seededBy` so the seeds come
 * from another retriever's top results for the same query.
 */
export function expandGraph(edges: EdgeTable, seeds: string[], options: GraphRetrieverOptions = {}): Hit[] {
  const hops = options.hops ?? 1;
  const allowed = options.relations ? new Set(options.relations) : null;
  const seen = new Set(seeds);
  let frontier = [...seeds];
  const hits: Hit[] = [];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const { neighbour, relation } of neighbours(edges, id, options.direction ?? "both")) {
        if (seen.has(neighbour) || (allowed && !allowed.has(relation))) continue;
        seen.add(neighbour);
        next.push(neighbour);
        hits.push({ id: neighbour, rank: hits.length + 1, payload: { hop, via: id, relation } });
      }
    }
    frontier = next;
  }
  return hits;
}

function neighbours(edges: EdgeTable, id: string, direction: "both" | "out"): { neighbour: string; relation: string }[] {
  const out = edges.from(id).map((e) => ({ neighbour: e.targetRef, relation: e.relation }));
  if (direction === "out") return out;
  return out.concat(edges.to(id).map((e) => ({ neighbour: e.sourceRef, relation: e.relation })));
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
