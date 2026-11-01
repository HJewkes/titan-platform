import type { ImportGraph } from "./import-graph.js";

interface Walk {
  index: Map<string, number>;
  low: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  components: string[][];
}

function popComponent(walk: Walk, root: string): string[] {
  const component: string[] = [];
  let node: string;
  do {
    node = walk.stack.pop()!;
    walk.onStack.delete(node);
    component.push(node);
  } while (node !== root);
  return component;
}

function visit(graph: ImportGraph, walk: Walk, node: string): void {
  walk.index.set(node, walk.index.size);
  walk.low.set(node, walk.index.get(node)!);
  walk.stack.push(node);
  walk.onStack.add(node);
  for (const next of graph.get(node) ?? []) {
    if (!walk.index.has(next)) {
      visit(graph, walk, next);
      walk.low.set(node, Math.min(walk.low.get(node)!, walk.low.get(next)!));
    } else if (walk.onStack.has(next)) {
      walk.low.set(node, Math.min(walk.low.get(node)!, walk.index.get(next)!));
    }
  }
  if (walk.low.get(node) === walk.index.get(node)) walk.components.push(popComponent(walk, node));
}

/** Tarjan's strongly connected components with more than one file, largest first. */
export function cycles(graph: ImportGraph): string[][] {
  const walk: Walk = { index: new Map(), low: new Map(), stack: [], onStack: new Set(), components: [] };
  for (const node of graph.keys()) if (!walk.index.has(node)) visit(graph, walk, node);
  return walk.components.filter((component) => component.length > 1).sort((a, b) => b.length - a.length);
}
