import { readEdges } from "./edges.js";
import type { Task } from "./task.js";

export interface TaskTreeNode {
  id: string;
  title: string;
  status: string;
  estimate: number | null;
  depth: number;
  children: TaskTreeNode[];
}

export interface TaskFloat {
  id: string;
  duration: number;
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  float: number;
}

export interface ExternalDep {
  task: string;
  dep: string;
}

export interface CriticalPathOptions {
  deliverable?: string;
}

export interface CriticalPathResult {
  /** Every task outside a cycle, in input order. */
  tasks: TaskFloat[];
  /** The zero-float task ids, by early start then input order. */
  criticalPath: string[];
  /** Remaining critical path length in points: the latest early finish. */
  length: number;
  /** True when cycles exist: their tasks and the edges through them add nothing, so `length` may be short. */
  lowerBound: boolean;
  /** Each cycle's task ids in input order; cycles ordered by their first member. */
  cycles: string[][];
  externalDeps: ExternalDep[];
  unestimated: string[];
}

// Stands in for the category registry's `closed` flag until callers pass the registry in.
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["done", "wont-do"]);

const isOpen = (task: Task): boolean => !CLOSED_STATUSES.has(task.status);

/** Rounds away the float error that fractional estimates like 0.5 leave behind. */
const round = (points: number): number => Math.round(points * 1e6) / 1e6;

const isEstimated = (task: Task): boolean =>
  typeof task.estimate === "number" && Number.isFinite(task.estimate) && task.estimate >= 0;

const firstById = (tasks: readonly Task[]): Map<string, Task> => {
  const byId = new Map<string, Task>();
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task);
  return byId;
};

const childrenByParent = (byId: Map<string, Task>): Map<string, Task[]> => {
  const children = new Map<string, Task[]>();
  for (const task of byId.values()) {
    const { parent } = readEdges(task);
    if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  return children;
};

/**
 * The subtree under `rootId` by `parent` edges, children in input order, or null when no task
 * has that id. A repeated id keeps its first task, and a parent cycle is cut where it would
 * revisit a task, so the walk always ends.
 */
export function taskTree(tasks: readonly Task[], rootId: string): TaskTreeNode | null {
  const byId = firstById(tasks);
  const children = childrenByParent(byId);
  const seen = new Set<string>();
  const build = (task: Task, depth: number): TaskTreeNode => {
    seen.add(task.id);
    const kids = (children.get(task.id) ?? []).filter((child) => !seen.has(child.id));
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      estimate: isEstimated(task) ? task.estimate! : null,
      depth,
      children: kids.map((child) => build(child, depth + 1)),
    };
  };
  const root = byId.get(rootId);
  return root === undefined ? null : build(root, 0);
}

interface Node {
  id: string;
  deps: string[];
  duration: number;
  estimated: boolean;
}

type Graph = Map<string, Node>;

function buildGraph(tasks: readonly Task[], { deliverable }: CriticalPathOptions): Graph {
  const graph: Graph = new Map();
  for (const task of firstById(tasks).values()) {
    const inScope = deliverable === undefined || (task.deliverables ?? []).includes(deliverable);
    if (!inScope || !isOpen(task)) continue;
    const estimated = isEstimated(task);
    graph.set(task.id, { id: task.id, deps: readEdges(task).dep, duration: estimated ? task.estimate! : 0, estimated });
  }
  return graph;
}

function externalDeps(graph: Graph): ExternalDep[] {
  return [...graph.values()].flatMap((node) =>
    node.deps.filter((dep) => !graph.has(dep)).map((dep) => ({ task: node.id, dep })),
  );
}

interface TarjanState {
  index: Map<string, number>;
  low: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  groups: string[][];
}

function strongConnect(graph: Graph, id: string, state: TarjanState): void {
  const { index, low, stack, onStack } = state;
  index.set(id, index.size);
  low.set(id, index.get(id)!);
  stack.push(id);
  onStack.add(id);
  for (const dep of graph.get(id)!.deps) {
    if (!graph.has(dep)) continue;
    if (!index.has(dep)) strongConnect(graph, dep, state);
    if (onStack.has(dep)) low.set(id, Math.min(low.get(id)!, low.get(dep)!));
  }
  if (low.get(id) !== index.get(id)) return;
  const group: string[] = [];
  let member: string;
  do {
    member = stack.pop()!;
    onStack.delete(member);
    group.push(member);
  } while (member !== id);
  state.groups.push(group);
}

/** Strongly connected groups of more than one task, plus self-dependent tasks, in input order. */
function findCycles(graph: Graph): string[][] {
  const state: TarjanState = { index: new Map(), low: new Map(), stack: [], onStack: new Set(), groups: [] };
  for (const id of graph.keys()) if (!state.index.has(id)) strongConnect(graph, id, state);
  const order = new Map([...graph.keys()].map((id, position) => [id, position]));
  const byInput = (a: string, b: string) => order.get(a)! - order.get(b)!;
  return state.groups
    .filter((group) => group.length > 1 || graph.get(group[0]!)!.deps.includes(group[0]!))
    .map((group) => group.sort(byInput))
    .sort((a, b) => byInput(a[0]!, b[0]!));
}

/** Drops cyclic tasks and every edge that leaves the acyclic set, so each dep is a scheduled task. */
function acyclicGraph(graph: Graph, cyclic: ReadonlySet<string>): Graph {
  const acyclic: Graph = new Map();
  for (const [id, node] of graph) {
    if (cyclic.has(id)) continue;
    acyclic.set(id, { ...node, deps: node.deps.filter((dep) => graph.has(dep) && !cyclic.has(dep)) });
  }
  return acyclic;
}

function successorsOf(graph: Graph): Map<string, string[]> {
  const successors = new Map([...graph.keys()].map((id) => [id, [] as string[]]));
  for (const node of graph.values()) for (const dep of node.deps) successors.get(dep)!.push(node.id);
  return successors;
}

/** Kahn's algorithm, seeded in input order; the graph is acyclic, so every task is placed. */
function topologicalOrder(graph: Graph, successors: Map<string, string[]>): string[] {
  const pending = new Map([...graph].map(([id, node]) => [id, node.deps.length]));
  const order = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
  for (let next = 0; next < order.length; next++) {
    for (const successor of successors.get(order[next]!)!) {
      const left = pending.get(successor)! - 1;
      pending.set(successor, left);
      if (left === 0) order.push(successor);
    }
  }
  return order;
}

function forwardPass(graph: Graph, order: readonly string[]): Map<string, number> {
  const earlyFinish = new Map<string, number>();
  for (const id of order) {
    const node = graph.get(id)!;
    const start = Math.max(0, ...node.deps.map((dep) => earlyFinish.get(dep)!));
    earlyFinish.set(id, start + node.duration);
  }
  return earlyFinish;
}

function backwardPass(
  graph: Graph,
  order: readonly string[],
  successors: Map<string, string[]>,
  length: number,
): Map<string, number> {
  const lateFinish = new Map<string, number>();
  const lateStart = (id: string) => lateFinish.get(id)! - graph.get(id)!.duration;
  for (const id of [...order].reverse()) {
    lateFinish.set(id, Math.min(length, ...successors.get(id)!.map(lateStart)));
  }
  return lateFinish;
}

function schedule(graph: Graph): { floats: Map<string, TaskFloat>; length: number } {
  const successors = successorsOf(graph);
  const order = topologicalOrder(graph, successors);
  const earlyFinish = forwardPass(graph, order);
  const length = Math.max(0, ...earlyFinish.values());
  const lateFinish = backwardPass(graph, order, successors, length);
  const floats = new Map<string, TaskFloat>();
  for (const id of order) {
    const { duration } = graph.get(id)!;
    const earlyStart = earlyFinish.get(id)! - duration;
    const lateStart = lateFinish.get(id)! - duration;
    floats.set(id, {
      id,
      duration,
      earlyStart: round(earlyStart),
      earlyFinish: round(earlyFinish.get(id)!),
      lateStart: round(lateStart),
      lateFinish: round(lateFinish.get(id)!),
      float: round(lateStart - earlyStart),
    });
  }
  return { floats, length: round(length) };
}

/**
 * Total float per open task from a forward and backward pass over the dep edges, with the
 * estimate in points as the duration. Float 0 means the task is on the critical path. Pure and
 * total: bad input is reported, never thrown.
 *
 * - The set is the open tasks, narrowed to those listing `deliverable` when one is given. A dep
 *   naming a task outside it (closed, another deliverable, unknown) is satisfied: it constrains
 *   nothing and is listed in `externalDeps`.
 * - A missing, NaN, infinite or negative estimate is duration 0 and is listed in `unestimated`.
 * - Tasks in a dep cycle are listed in `cycles` and get no float; a dep on one constrains
 *   nothing, so with any cycle `length` is only a lower bound (`lowerBound`).
 * - A repeated id keeps its first task.
 */
export function criticalPath(tasks: readonly Task[], options: CriticalPathOptions = {}): CriticalPathResult {
  const graph = buildGraph(tasks, options);
  const cycles = findCycles(graph);
  const acyclic = acyclicGraph(graph, new Set(cycles.flat()));
  const { floats, length } = schedule(acyclic);
  const scheduled = [...acyclic.keys()].flatMap((id) => floats.get(id) ?? []);
  const critical = scheduled.filter((task) => task.float === 0);
  return {
    tasks: scheduled,
    criticalPath: critical.sort((a, b) => a.earlyStart - b.earlyStart).map((task) => task.id),
    length,
    lowerBound: cycles.length > 0,
    cycles,
    externalDeps: externalDeps(graph),
    unestimated: [...graph.values()].filter((node) => !node.estimated).map((node) => node.id),
  };
}
