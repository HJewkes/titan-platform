import { findCallPath, type CodeGraphStore, type GraphEdge, type GraphNode } from "@titan-design/code-graph";
import { factFiles, toFileId } from "./centrality.js";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import type { ExplainerFact } from "./schemas.js";
import type { CallPath } from "./structure-schema.js";

/** The topic priorities the tour walks a call path for. */
export const CALL_PATH_PRIORITIES = new Set(["P1", "P2"]);

export interface CallTarget {
  factId: string;
  /** The innermost symbol at the fact's first indexed citation, else that file. */
  target: string;
}

function spanOf(node: GraphNode): { start: number; end: number } | undefined {
  const { startLine, endLine } = node.attrs ?? {};
  return typeof startLine === "number" && typeof endLine === "number" ? { start: startLine, end: endLine } : undefined;
}

/** The smallest symbol span in `fileId` holding `line`, so a method wins over its class; the file when none does. */
export function symbolAt(nodes: readonly GraphNode[], fileId: string, line: number | undefined): string {
  if (line === undefined) return fileId;
  let best: { id: string; size: number } | undefined;
  for (const node of nodes) {
    const span = node.kind === "symbol" && node.parentId === fileId ? spanOf(node) : undefined;
    if (span === undefined || line < span.start || line > span.end) continue;
    const size = span.end - span.start;
    if (best === undefined || size < best.size) best = { id: node.id, size };
  }
  return best?.id ?? fileId;
}

/** One target per P1/P2 topic fact that cites an indexed file. */
export function callTargets(facts: readonly ExplainerFact[], nodes: readonly GraphNode[], indexed: ReadonlySet<string>): CallTarget[] {
  return facts
    .filter((fact) => fact.source === "topic" && CALL_PATH_PRIORITIES.has(fact.priority ?? ""))
    .flatMap((fact) => {
      const [fileId] = factFiles(fact, indexed).resolved;
      if (fileId === undefined) return [];
      const span = fact.evidence.find((cite) => toFileId(cite.path) === fileId && cite.lineStart !== undefined);
      return [{ factId: fact.id, target: symbolAt(nodes, fileId, span?.lineStart) }];
    });
}

// A node no graph id can equal: it calls every start symbol, so one breadth-first search covers them all.
const START = "\u0000entries";

/** The entry files to search from, tried in order: a later tier runs only for a target the earlier ones miss. */
export type EntryTiers = readonly (readonly string[])[];

interface Tier {
  entries: readonly string[];
  edges: GraphEdge[];
}

function tierOf(entries: readonly string[], symbols: readonly GraphNode[], edges: readonly GraphEdge[]): Tier {
  const files = new Set(entries);
  const starts = symbols.filter((s) => files.has(s.parentId ?? "")).map((s) => s.id);
  return { entries, edges: [...edges, ...starts.map((dstId) => ({ srcId: START, dstId, kind: "calls" as const }))] };
}

/**
 * The shortest `calls` path from any entry file's symbols to each target, id order breaking ties, via
 * code-graph's `findCallPath` over the snapshot's edges (what `snapshotCallPath` reads) plus one virtual
 * start node per tier. A target no tier reaches gets a null path and a `W-NO-CALL-PATH`; the rest still run.
 */
export function callPaths(
  store: CodeGraphStore,
  snapshotId: number,
  tiers: EntryTiers,
  targets: readonly CallTarget[],
): { paths: CallPath[]; diagnostics: GatherDiagnostic[] } {
  const nodes = store.listNodes(snapshotId, { includeSymbols: true });
  const fileOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  const edges = store.listEdges(snapshotId, { includeReferences: true });
  const searched = tiers.map((entries) => tierOf(entries, nodes.filter((n) => n.kind === "symbol"), edges));
  const diagnostics: GatherDiagnostic[] = [];
  const paths = targets.map(({ factId, target }): CallPath => {
    for (const tier of searched) {
      const path = findCallPath(tier.edges, START, target)?.slice(1);
      if (path !== undefined) return { fact_id: factId, entry: fileOf.get(path[0]!) ?? null, target, path, via: "calls" };
    }
    diagnostics.push(diag("W-NO-CALL-PATH", `no calls path reaches ${target} from ${tiers.flat().length} entry files`, factId));
    return { fact_id: factId, entry: null, target, path: null, via: null };
  });
  return { paths, diagnostics };
}
