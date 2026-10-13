/** Every node is a key; its list holds the nodes it points at. */
export type Adjacency = Map<string, string[]>;

interface Tarjan {
  graph: Adjacency;
  index: Map<string, number>;
  low: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  frames: { id: string; next: number }[];
  out: string[][];
}

/** Iterative Tarjan, so a long import chain cannot overflow the call stack. Singletons are included. */
export function stronglyConnected(graph: Adjacency): string[][] {
  const t: Tarjan = { graph, index: new Map(), low: new Map(), stack: [], onStack: new Set(), frames: [], out: [] };
  for (const root of graph.keys()) {
    if (t.index.has(root)) continue;
    visit(t, root);
    while (t.frames.length > 0) step(t);
  }
  return t.out;
}

/** A component that forms a cycle: two or more nodes, or one node pointing at itself. */
export function isCyclic(graph: Adjacency, scc: readonly string[]): boolean {
  return scc.length > 1 || (graph.get(scc[0]!)?.includes(scc[0]!) ?? false);
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
