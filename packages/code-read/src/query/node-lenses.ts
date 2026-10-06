import {
  buildHotExports,
  collectNodeMetrics,
  collectSymbolUtil,
  computeSymbolConsumers,
  linkTestsToSources,
  topCentralFiles,
  type CentralRow,
  type NodeMetrics,
  type SymbolUtil,
  type TestSourceLink,
} from "@titan-design/code-graph/analysis";
import type { CommandArgs } from "./contract.js";
import type { NodeLens, NodeLenses } from "./contract-node-lenses.js";
import { inputsFor, reportContext, scoredRows } from "./hotspots.js";
import type { ReadModel } from "./model.js";
import { toRef, type TreeNode } from "./tree.js";

type LensArgs = Pick<CommandArgs<"node.get">, "lenses" | "window">;
type CentralInput = Parameters<typeof topCentralFiles>;

interface SymbolFacts {
  metrics: ReadonlyMap<string, NodeMetrics>;
  symbols: readonly SymbolUtil[];
  consumers: ReadonlyMap<string, number>;
}

/** One derivation per snapshot model: snapshots are immutable, so the whole-graph work is done once. */
function perModel<T>(derive: (model: ReadModel) => T): (model: ReadModel) => T {
  const cache = new WeakMap<ReadModel, T>();
  return (model) => {
    if (!cache.has(model)) cache.set(model, derive(model));
    return cache.get(model)!;
  };
}

/** Every file code-graph's reading order keeps, most central first; files and structural edges only. */
export const centralFiles = perModel((model): CentralRow[] => {
  const nodes = inputsFor(model).nodes.filter((n) => n.kind !== "symbol");
  const edges = model.edges.filter((e) => e.kind !== "references" && e.kind !== "calls") as CentralInput[1];
  // keepNode reads no churn, so any window gives the same ranking.
  return topCentralFiles(nodes, edges, reportContext(model, "lifetime"), Infinity);
});

const symbolFacts = perModel((model): SymbolFacts => {
  const { nodes, metrics: rows } = inputsFor(model);
  const metrics = collectNodeMetrics([...rows]);
  const references = model.edges.filter((e) => e.kind === "references");
  const consumers = new Map(computeSymbolConsumers(references).map((s) => [s.symbolId, s.consumers.length]));
  return { metrics, symbols: collectSymbolUtil(nodes, metrics), consumers };
});

// Without stored co-change pairs only the path-convention pass can link a test.
const testLinks = perModel((model): TestSourceLink[] => linkTestsToSources(inputsFor(model).nodes, []));

function exportsOf(model: ReadModel, fileId: string): NodeLenses["exports"] {
  const { metrics, symbols, consumers } = symbolFacts(model);
  const declared = symbols.filter((s) => s.fileId === fileId);
  const rows = buildHotExports(declared, new Set([fileId]), metrics, consumers)[fileId] ?? [];
  return rows.map((r) => ({ name: r.name, utilization: r.utilization, cognitive: r.cognitive ?? null, consumers: r.consumers, exported: r.exported }));
}

function scoreOf(model: ReadModel, node: TreeNode, window: string): NodeLenses["score"] {
  const grain = node.ref.kind;
  if (grain !== "file" && grain !== "symbol") return null;
  const rows = scoredRows(model, { grain, window });
  const at = rows.findIndex((r) => r.nodeId === node.ref.id);
  if (at < 0) return { grain, window, score: 0, rank: null, ranked: rows.length };
  const { score, churn, complexity, recency, utilization } = rows[at]!;
  const factors = utilization === undefined ? { churn, complexity, recency } : { churn, complexity, recency, utilization };
  return { grain, window, score, ...factors, rank: at + 1, ranked: rows.length };
}

function centralityOf(model: ReadModel, fileId: string): NodeLenses["centrality"] {
  const rows = centralFiles(model);
  const at = rows.findIndex((r) => r.nodeId === fileId);
  return { score: at < 0 ? null : rows[at]!.score, rank: at < 0 ? null : at + 1, of: rows.length };
}

function testsOf(model: ReadModel, fileId: string): NodeLenses["tests"] {
  const tests = testLinks(model)
    .filter((l) => l.sourceId === fileId)
    .map((l) => toRef(model.nodeById.get(l.testId)!));
  const counts = model.metrics.get("linked_test_count");
  const indexedCount = counts ? (counts.get(fileId) ?? 0) : null;
  return { tests, indexedCount, coEditMeasured: false };
}

function lensOf(model: ReadModel, node: TreeNode, lens: NodeLens, window: string): NodeLenses[NodeLens] {
  if (lens === "score") return scoreOf(model, node, window);
  if (node.ref.kind !== "file") return null;
  const id = node.ref.id;
  if (lens === "exports") return exportsOf(model, id);
  if (lens === "centrality") return centralityOf(model, id);
  if (lens === "tests") return testsOf(model, id);
  // Co-change pairs are not stored in the index yet, so coupled partners cannot be measured here.
  return { measured: false, partners: [] };
}

/** The requested lenses on one node, keyed by lens. */
export function lensesFor(model: ReadModel, node: TreeNode, args: LensArgs): NodeLenses {
  return Object.fromEntries(args.lenses.map((lens) => [lens, lensOf(model, node, lens, args.window)]));
}
