import { getLanguageFromPath, type GraphEdge, type GraphNode } from "@titan-design/code-graph";
import { CONTRACT, getNode, getOverview, OVERVIEW_ROWS_MAX, type ReadSource } from "@titan-design/code-read";
import { packageOf } from "@titan-design/graph-layout";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import type { ExplainerFact } from "./schemas.js";
import type { FileCentrality, Structure } from "./structure-schema.js";

/** A fact citing this many indexed files reads better as a graph than as a code card. */
const GRAPH_SHAPE_FILES = 3;

const ROOT_ROLES = new Set<GraphNode["role"]>(["source", "entry", undefined]);
const IMPORT_KINDS = new Set<GraphEdge["kind"]>(["imports", "re-exports"]);

/** A cited path the indexer would read: TypeScript or Python source. */
function isCodePath(path: string): boolean {
  return getLanguageFromPath(path) !== null;
}

/** A review cites `./src/a.ts` as often as `src/a.ts`; graph file ids carry no leading `./`. */
export function toFileId(path: string): string {
  return path.replace(/^(?:\.\/)+/, "");
}

/** code-read's centrality lens for each file, in path order; generated files come back with a null rank. */
export function rankFiles(source: ReadSource, snapshotId: number, fileIds: Iterable<string>): FileCentrality[] {
  return [...new Set(fileIds)].sort().map((id) => {
    const args = CONTRACT["node.get"].args.parse({ snapshot: snapshotId, id, lenses: ["centrality"] });
    const centrality = getNode(source, args).lenses?.centrality;
    return { path: id, score: centrality?.score ?? null, rank: centrality?.rank ?? null, of: centrality?.of ?? 0 };
  });
}

/** The repo-wide reading order, most central first, at code-read's row cap. */
export function readingOrder(source: ReadSource, snapshotId: number): Structure["reading_order"] {
  const args = CONTRACT["overview.get"].args.parse({ snapshot: snapshotId, reading_limit: OVERVIEW_ROWS_MAX });
  return getOverview(source, args).readingOrder.map((row) => ({ path: row.node.path, centrality: row.centrality }));
}

// Rank-based, so a fact's centrality compares across repos of any size: the top file is 1, the last is 1/of.
function normalized(rank: FileCentrality): number | null {
  return rank.rank === null || rank.of === 0 ? null : 1 - (rank.rank - 1) / rank.of;
}

interface FactStructure {
  centrality: number | null;
  reading_rank: number | null;
  module?: string;
  shape_hints: { graph: boolean };
}

function factStructure(resolved: readonly string[], ranks: ReadonlyMap<string, FileCentrality>): FactStructure {
  const ranked = resolved.flatMap((id) => {
    const rank = ranks.get(id);
    return rank === undefined || rank.rank === null ? [] : [{ ...rank, rank: rank.rank }];
  });
  ranked.sort((a, b) => a.rank - b.rank);
  const top = ranked[0]?.path ?? resolved[0];
  const scores = ranked.map(normalized).filter((score) => score !== null);
  return {
    centrality: scores.length === 0 ? null : Math.max(...scores),
    reading_rank: ranked[0]?.rank ?? null,
    ...(top === undefined ? {} : { module: packageOf(top) }),
    shape_hints: { graph: resolved.length >= GRAPH_SHAPE_FILES },
  };
}

/** The distinct indexed files a fact cites, in citation order. */
export function factFiles(fact: ExplainerFact, indexed: ReadonlySet<string>): { resolved: string[]; unresolved: string[] } {
  const cited = [...new Set(fact.evidence.map((span) => toFileId(span.path)).filter(isCodePath))];
  return { resolved: cited.filter((id) => indexed.has(id)), unresolved: cited.filter((id) => !indexed.has(id)) };
}

/**
 * Each fact with its structure fields: centrality is the best of its cited files, reading rank the
 * earliest, module the package of the most central one. A cited code path outside the index is one
 * `W-UNRESOLVED` per path, naming the facts that cite it.
 */
export function enrichFacts(
  facts: readonly ExplainerFact[],
  ranks: ReadonlyMap<string, FileCentrality>,
  indexed: ReadonlySet<string>,
): { facts: ExplainerFact[]; diagnostics: GatherDiagnostic[] } {
  const unresolved = new Map<string, string[]>();
  const enriched = facts.map((fact) => {
    const files = factFiles(fact, indexed);
    for (const id of files.unresolved) unresolved.set(id, [...(unresolved.get(id) ?? []), fact.id]);
    return { ...fact, ...factStructure(files.resolved, ranks) };
  });
  const diagnostics = [...unresolved].map(([id, factIds]) =>
    diag("W-UNRESOLVED", `${id} is not in the index; cited by ${factIds.join(", ")}`, id),
  );
  return { facts: enriched, diagnostics };
}

/** Source files no other source file imports: where a reader can start. Tests and config neither count nor import. */
export function entryRoots(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string[] {
  const sources = new Set(nodes.filter((node) => node.kind === "file" && ROOT_ROLES.has(node.role)).map((node) => node.id));
  const imported = new Set(
    edges.filter((e) => IMPORT_KINDS.has(e.kind) && e.srcId !== e.dstId && sources.has(e.srcId)).map((e) => e.dstId),
  );
  return [...sources].filter((id) => !imported.has(id)).sort();
}
