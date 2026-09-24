import { readParamShape, type CallEdgeAttrs, type CallSite, type ParamShape } from "../extractors/call-sites.js";
import { parseSymbolId } from "../extractors/ids.js";
import type { GraphEdge, GraphMetric, GraphNode } from "../types.js";

export const CALL_METRIC_NAMES: ReadonlySet<string> = new Set([
  "symbol_caller_count",
  "symbol_single_caller_helper",
  "symbol_constant_params",
]);

/** Placeholder for a parameter a site does not pass; no literal's source text can equal it. */
const ABSENT = "<absent>";

interface Inbound {
  callers: Set<string>;
  sites: CallSite[];
}

/**
 * Call-graph metrics over the assembled `calls` edges (TP-323). They depend on
 * edges from every file, so they are recomputed on each index rather than
 * carried forward with a reused file. Written on each function, method and
 * class symbol (the nodes with a line span): `symbol_caller_count`, the distinct
 * other symbols or files that call it; `symbol_single_caller_helper`, 1 for a
 * non-exported, non-dunder symbol whose one caller is a symbol; and, once a callable has 2
 * resolved call sites, `symbol_constant_params`.
 */
export function computeCallMetrics(nodes: Iterable<GraphNode>, edges: Iterable<GraphEdge>): GraphMetric[] {
  const inbound = collectInbound(edges);
  const out: GraphMetric[] = [];
  for (const node of nodes) {
    if (node.kind !== "symbol" || node.attrs?.startLine === undefined) continue;
    const { callers, sites } = inbound.get(node.id) ?? { callers: new Set<string>(), sites: [] };
    out.push({ nodeId: node.id, name: "symbol_caller_count", value: callers.size, unit: "count" });
    const single = isPrivateHelper(node) && callers.size === 1 && isSymbolCaller(callers);
    out.push({ nodeId: node.id, name: "symbol_single_caller_helper", value: single ? 1 : 0, unit: "count" });
    const shape = readParamShape(node.attrs);
    if (shape && sites.length >= 2) {
      out.push({ nodeId: node.id, name: "symbol_constant_params", value: constantParams(shape, sites), unit: "count" });
    }
  }
  return out;
}

/** Callers exclude the callee itself, so recursion is not a caller; its sites still count. */
function collectInbound(edges: Iterable<GraphEdge>): Map<string, Inbound> {
  const inbound = new Map<string, Inbound>();
  for (const edge of edges) {
    if (edge.kind !== "calls") continue;
    let entry = inbound.get(edge.dstId);
    if (!entry) inbound.set(edge.dstId, (entry = { callers: new Set(), sites: [] }));
    if (edge.srcId !== edge.dstId) entry.callers.add(edge.srcId);
    entry.sites.push(...((edge.attrs as CallEdgeAttrs | undefined)?.sites ?? []));
  }
  return inbound;
}

/** Non-exported, and not a Python `__dunder__`, which the runtime calls through its protocol. */
function isPrivateHelper(node: GraphNode): boolean {
  const own = node.name.slice(node.name.lastIndexOf(".") + 1);
  return node.attrs?.exported === false && !(own.startsWith("__") && own.endsWith("__"));
}

function isSymbolCaller(callers: ReadonlySet<string>): boolean {
  return [...callers].every((id) => parseSymbolId(id) !== null);
}

/** Parameters every site passes the same literal, or none passes; unknown at any site means not constant. */
export function constantParams(shape: ParamShape, sites: readonly CallSite[]): number {
  let count = 0;
  shape.params.forEach((name, index) => {
    const values = sites.map((site) => argumentAt(site, name, index < shape.positional ? index : -1));
    if (values.every((v) => v !== null && v === values[0])) count++;
  });
  return count;
}

/** The literal text a site passes for one parameter, ABSENT when it passes nothing, or null when unknown. */
function argumentAt(site: CallSite, name: string, position: number): string | null {
  if (position >= 0 && position < site.args.length) return site.args[position] ?? null;
  if (site.kwargs && Object.hasOwn(site.kwargs, name)) return site.kwargs[name] ?? null;
  if (site.kwSplat) return null;
  if (position >= 0 && site.spreadFrom !== undefined && position >= site.spreadFrom) return null;
  return ABSENT;
}
