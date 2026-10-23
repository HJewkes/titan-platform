import { snapshotCallPath, type CodeGraphStore, type GraphNode } from "@titan-design/code-graph";
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

// Code-unit order, not localeCompare, so the chosen path cannot vary with the host locale.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function shorterFirst(a: string[], b: string[]): number {
  return a.length - b.length || byText(JSON.stringify(a), JSON.stringify(b));
}

interface Found {
  entry: string;
  path: string[];
}

function bestPath(store: CodeGraphStore, snapshotId: number, starts: ReadonlyMap<string, string[]>, target: string): Found | undefined {
  let best: Found | undefined;
  for (const [entry, symbols] of starts) {
    for (const from of symbols) {
      const path = snapshotCallPath(store, snapshotId, from, target);
      if (path !== null && (best === undefined || shorterFirst(path, best.path) < 0)) best = { entry, path };
    }
  }
  return best;
}

/**
 * The shortest `calls` path from any entry file's symbols to each target, id order breaking ties.
 * A target no entry reaches gets a null path and a `W-NO-CALL-PATH`; the other targets still run.
 */
export function callPaths(
  store: CodeGraphStore,
  snapshotId: number,
  entries: readonly string[],
  targets: readonly CallTarget[],
): { paths: CallPath[]; diagnostics: GatherDiagnostic[] } {
  const symbols = store.listNodes(snapshotId, { includeSymbols: true }).filter((node) => node.kind === "symbol");
  const starts = new Map(entries.map((entry) => [entry, symbols.filter((s) => s.parentId === entry).map((s) => s.id).sort(byText)]));
  const diagnostics: GatherDiagnostic[] = [];
  const paths = targets.map(({ factId, target }): CallPath => {
    const found = bestPath(store, snapshotId, starts, target);
    if (found !== undefined) return { fact_id: factId, entry: found.entry, target, path: found.path, via: "calls" };
    diagnostics.push(diag("W-NO-CALL-PATH", `no calls path reaches ${target} from ${entries.join(", ") || "any entry"}`, factId));
    return { fact_id: factId, entry: null, target, path: null, via: null };
  });
  return { paths, diagnostics };
}
