import type { GraphEdge } from "../types.js";
import type { RuleContext } from "./context.js";
import { compilePatterns, matchesAny } from "./patterns.js";
import { isImportEdge, severityOf } from "./rule-helpers.js";
import type { CheckViolation, NoImportCyclesRule } from "./types.js";

type Adjacency = Map<string, string[]>;

/** Each strongly connected component of two or more files, or one file importing itself, is one cycle. */
export function runNoImportCyclesRule(rule: NoImportCyclesRule, ctx: RuleContext): CheckViolation[] {
  const graph = importGraph(rule, ctx);
  return stronglyConnected(graph)
    .filter((scc) => scc.length > 1 || graph.get(scc[0]!)!.includes(scc[0]!))
    .map((scc) => cycleViolation(rule, scc.sort()));
}

function cycleViolation(rule: NoImportCyclesRule, members: string[]): CheckViolation {
  const evidence = `import cycle of ${members.length} file(s): ${members.join(", ")}`;
  return {
    ruleId: rule.id,
    severity: severityOf(rule),
    nodeId: members[0]!,
    members,
    value: members.length,
    message: evidence,
    evidence,
  };
}

function importGraph(rule: NoImportCyclesRule, ctx: RuleContext): Adjacency {
  const excluders = compilePatterns(rule.exclude);
  const excludedRoles = new Set(rule.excludeRoles ?? []);
  const inGraph = (id: string): boolean => {
    const node = ctx.nodesById.get(id);
    if (node?.kind !== "file" || matchesAny(id, excluders)) return false;
    return node.role === undefined || !excludedRoles.has(node.role);
  };
  const graph: Adjacency = new Map();
  for (const edge of ctx.edges) {
    if (!countsAsImport(edge, rule.includeTypeOnly === true)) continue;
    if (!inGraph(edge.srcId) || !inGraph(edge.dstId)) continue;
    adjacent(graph, edge.srcId).push(edge.dstId);
    adjacent(graph, edge.dstId);
  }
  return graph;
}

function countsAsImport(edge: GraphEdge, includeTypeOnly: boolean): boolean {
  return isImportEdge(edge) && (includeTypeOnly || edge.attrs?.typeOnly !== true);
}

function adjacent(graph: Adjacency, id: string): string[] {
  let list = graph.get(id);
  if (!list) {
    list = [];
    graph.set(id, list);
  }
  return list;
}

interface Tarjan {
  graph: Adjacency;
  index: Map<string, number>;
  low: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  frames: { id: string; next: number }[];
  out: string[][];
}

/** Iterative Tarjan, so a long import chain cannot overflow the call stack. */
function stronglyConnected(graph: Adjacency): string[][] {
  const t: Tarjan = { graph, index: new Map(), low: new Map(), stack: [], onStack: new Set(), frames: [], out: [] };
  for (const root of graph.keys()) {
    if (t.index.has(root)) continue;
    visit(t, root);
    while (t.frames.length > 0) step(t);
  }
  return t.out;
}

function visit(t: Tarjan, id: string): void {
  t.index.set(id, t.index.size);
  t.low.set(id, t.index.get(id)!);
  t.stack.push(id);
  t.onStack.add(id);
  t.frames.push({ id, next: 0 });
}

function step(t: Tarjan): void {
  const frame = t.frames[t.frames.length - 1]!;
  const dst = t.graph.get(frame.id)![frame.next++];
  if (dst === undefined) {
    t.frames.pop();
    finish(t, frame.id, t.frames[t.frames.length - 1]?.id);
  } else if (!t.index.has(dst)) {
    visit(t, dst);
  } else if (t.onStack.has(dst)) {
    lowerTo(t, frame.id, t.index.get(dst)!);
  }
}

function lowerTo(t: Tarjan, id: string, value: number): void {
  t.low.set(id, Math.min(t.low.get(id)!, value));
}

function finish(t: Tarjan, id: string, parent: string | undefined): void {
  if (parent !== undefined) lowerTo(t, parent, t.low.get(id)!);
  if (t.low.get(id) !== t.index.get(id)) return;
  const scc: string[] = [];
  let member: string;
  do {
    member = t.stack.pop()!;
    t.onStack.delete(member);
    scc.push(member);
  } while (member !== id);
  t.out.push(scc);
}
