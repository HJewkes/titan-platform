import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTreeSource, indexPaths, openCodeGraph } from "@titan-design/code-graph";

/** A call from one symbol to another, as code-graph ids `<path>#<symbol>` (a top-level call's caller is the file). */
export interface CallEdge {
  from: string;
  to: string;
  sites: number;
}

/** Every call edge in the clone at `headSha`; tests pass a fake, production indexes with code-graph. */
export type CallEdgeReader = (clonePath: string, headSha: string) => Promise<CallEdge[]>;

const sitesOf = (attrs: Record<string, unknown> | undefined): number => (Array.isArray(attrs?.sites) ? attrs.sites.length : 1);

/**
 * Indexes the head commit's tree from git objects, so the clone needs the commit but no checkout of it,
 * into a scratch store that is deleted after the read.
 */
export const codeGraphCallEdges: CallEdgeReader = async (clonePath, headSha) => {
  const dir = await mkdtemp(join(tmpdir(), "explainer-pr-graph-"));
  const store = openCodeGraph(join(dir, "graph.sqlite3"));
  try {
    const source = gitTreeSource(clonePath, headSha);
    const { snapshotId } = await indexPaths(store, { paths: [clonePath], source, computeChurn: false, detectRenames: false, incremental: false });
    return store
      .listEdges(snapshotId, { includeReferences: true })
      .filter((edge) => edge.kind === "calls")
      .map((edge) => ({ from: edge.srcId, to: edge.dstId, sites: sitesOf(edge.attrs) }));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
};

export const fileOf = (id: string): string => id.split("#")[0]!;

/** Calls from one changed file into another: the interactions the PR touches on both ends, for the sequence slot. */
export function crossFileEdges(edges: readonly CallEdge[], changed: ReadonlySet<string>): CallEdge[] {
  return edges.filter((edge) => {
    const [from, to] = [fileOf(edge.from), fileOf(edge.to)];
    return from !== to && changed.has(from) && changed.has(to);
  });
}
