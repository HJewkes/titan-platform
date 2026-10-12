import { type Adjacency, isCyclic, stronglyConnected } from "../graph-scc.js";
import type { GraphEdge } from "../types.js";
import type { RuleContext } from "./context.js";
import { compilePatterns, matchesAny } from "./patterns.js";
import { isImportEdge, severityOf } from "./rule-helpers.js";
import type { CheckViolation, CycleKind, NoImportCyclesRule } from "./types.js";

interface ImportLink {
  src: string;
  dst: string;
  typeOnly: boolean;
}

interface CycleShape {
  kind: CycleKind;
  hub?: { id: string; typeOnlyInbound: number };
}

/** Each strongly connected component of two or more files, or one file importing itself, is one cycle. */
export function runNoImportCyclesRule(rule: NoImportCyclesRule, ctx: RuleContext): CheckViolation[] {
  const links = importLinks(rule, ctx);
  const graph = adjacencyOf(links);
  return stronglyConnected(graph)
    .filter((scc) => isCyclic(graph, scc))
    .map((scc) => scc.sort())
    .map((members) => cycleViolation(rule, members, cycleShape(members, links)));
}

function cycleViolation(rule: NoImportCyclesRule, members: string[], shape: CycleShape): CheckViolation {
  const files = `${members.length} file(s): ${members.join(", ")}`;
  const evidence =
    shape.kind === "value"
      ? `import cycle of ${files}`
      : `type-only import cycle of ${files}; hub ${shape.hub!.id} (${shape.hub!.typeOnlyInbound} type-only import(s) in)`;
  return {
    ruleId: rule.id,
    severity: severityOf(rule),
    nodeId: members[0]!,
    members,
    value: members.length,
    message: evidence,
    evidence,
    cycleKind: shape.kind,
    ...(shape.hub ? { hub: shape.hub.id } : {}),
  };
}

/**
 * A cycle is type-only when its value imports alone close no cycle among its members; then
 * only type-checking ties the files together, and breaking it means moving the types its hub holds.
 */
function cycleShape(members: readonly string[], links: readonly ImportLink[]): CycleShape {
  const inside = new Set(members);
  const internal = links.filter((l) => inside.has(l.src) && inside.has(l.dst));
  const valueGraph = adjacencyOf(internal.filter((l) => !l.typeOnly));
  if (stronglyConnected(valueGraph).some((scc) => isCyclic(valueGraph, scc))) return { kind: "value" };
  return { kind: "type-only", hub: typeHub(members, internal) };
}

/** The member most other members import types from; ties go to the first id in sort order. */
function typeHub(members: readonly string[], internal: readonly ImportLink[]): { id: string; typeOnlyInbound: number } {
  const inbound = new Map<string, number>();
  for (const l of internal) if (l.typeOnly) inbound.set(l.dst, (inbound.get(l.dst) ?? 0) + 1);
  let hub = { id: members[0]!, typeOnlyInbound: inbound.get(members[0]!) ?? 0 };
  for (const id of members) {
    const count = inbound.get(id) ?? 0;
    if (count > hub.typeOnlyInbound) hub = { id, typeOnlyInbound: count };
  }
  return hub;
}

function importLinks(rule: NoImportCyclesRule, ctx: RuleContext): ImportLink[] {
  const excluders = compilePatterns(rule.exclude);
  const excludedRoles = new Set(rule.excludeRoles ?? []);
  const inGraph = (id: string): boolean => {
    const node = ctx.nodesById.get(id);
    if (node?.kind !== "file" || matchesAny(id, excluders)) return false;
    return node.role === undefined || !excludedRoles.has(node.role);
  };
  return ctx.edges
    .filter((edge) => countsAsImport(edge, rule.includeTypeOnly === true))
    .filter((edge) => inGraph(edge.srcId) && inGraph(edge.dstId))
    .map((edge) => ({ src: edge.srcId, dst: edge.dstId, typeOnly: edge.attrs?.typeOnly === true }));
}

function countsAsImport(edge: GraphEdge, includeTypeOnly: boolean): boolean {
  return isImportEdge(edge) && (includeTypeOnly || edge.attrs?.typeOnly !== true);
}

function adjacencyOf(links: readonly ImportLink[]): Adjacency {
  const graph: Adjacency = new Map();
  for (const { src, dst } of links) {
    adjacent(graph, src).push(dst);
    adjacent(graph, dst);
  }
  return graph;
}

function adjacent(graph: Adjacency, id: string): string[] {
  let list = graph.get(id);
  if (!list) {
    list = [];
    graph.set(id, list);
  }
  return list;
}
