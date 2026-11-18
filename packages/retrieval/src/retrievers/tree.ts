import type { Hit, RetrieveOptions, Retriever } from "../types.js";

/** One node of a summary tree. Level 0 is a leaf; higher levels summarise the leaves in `leafIds`. */
export interface SummaryNode {
  id: string;
  level: number;
  parentId: string | null;
  leafIds: string[];
  text: string;
}

export interface CollapsedTreeOptions {
  nodes: SummaryNode[];
  /** Ranks node ids by node text; build it over the same texts as `nodes`. */
  inner: Retriever;
  /** Drop every node above level 0, for the ablation against the full tree. */
  leavesOnly?: boolean;
  name?: string;
}

/**
 * Collapsed-tree retrieval: every node of every level competes in one ranking,
 * so a broad query can land on a summary and a detail query on a leaf. Each hit
 * carries `level` and `leafIds`; cite the leaves, never the summary text.
 */
export function collapsedTreeRetriever(options: CollapsedTreeOptions): Retriever {
  const byId = new Map(options.nodes.map((n) => [n.id, n]));
  const summaryCount = options.nodes.filter((n) => n.level > 0).length;
  const leavesOnly = options.leavesOnly === true;
  return {
    name: options.name ?? "tree",
    async retrieve(query: string, { limit, signal }: RetrieveOptions): Promise<Hit[]> {
      // Summaries are dropped after ranking, so ask for enough extra to fill `limit` with leaves.
      const fetched = await options.inner.retrieve(query, { limit: leavesOnly ? limit + summaryCount : limit, signal });
      const hits: Hit[] = [];
      for (const hit of fetched) {
        const node = byId.get(hit.id);
        if (!node || (leavesOnly && node.level > 0)) continue;
        hits.push({ id: node.id, rank: hits.length + 1, score: hit.score, payload: { level: node.level, leafIds: node.leafIds, parentId: node.parentId } });
        if (hits.length >= limit) break;
      }
      return hits;
    },
  };
}
