import { TASK_ID_REGEX, type Task } from "./task.js";

export interface Edges {
  parent: string | null;
  dep: string[];
}

export type EdgeField = "parent" | "dep";

/** A proposed edit to one task's edges. An omitted field keeps the task's current edges. */
export interface EdgeChange {
  id: string;
  parent?: string | null;
  dep?: string[];
}

export type EdgeError =
  | { kind: "unknown-id"; id: string; field: EdgeField; ref: string }
  | { kind: "cycle"; field: EdgeField; ids: string[] };

export interface CrossInitiativeParentWarning {
  kind: "cross-initiative-parent";
  id: string;
  parent: string;
}

export interface EdgeCheck {
  errors: EdgeError[];
  warnings: CrossInitiativeParentWarning[];
}

const PARENT_TAG_PREFIXES = ["epic:", "parent:"];
const DEP_TAG_PREFIXES = ["dep:", "blocked-by:"];

const tagValues = (tags: readonly string[], prefixes: readonly string[]): string[] =>
  tags.flatMap((tag) => {
    const prefix = prefixes.find((p) => tag.startsWith(p));
    const value = prefix === undefined ? "" : tag.slice(prefix.length);
    return TASK_ID_REGEX.test(value) ? [value] : [];
  });

/**
 * Returns a task's parent and dep edges. A field, when present, wins outright. Without it the
 * edge is read from `epic:`/`parent:` or `dep:`/`blocked-by:` tags whose value is a task id.
 *
 * The tag read is a migration fallback, not a lasting path: tags are for retrieval only
 * (decisions item 90), and this fallback goes once the edge tags are migrated to fields.
 * `blocks:` is not read here, because it names the inverse edge on the other task; only the
 * migration can turn it into that task's `dep`.
 */
export function readEdges(task: Task): Edges {
  const tags = task.tags ?? [];
  const parent = task.parent ?? tagValues(tags, PARENT_TAG_PREFIXES)[0] ?? null;
  const dep = task.dep ?? [...new Set(tagValues(tags, DEP_TAG_PREFIXES))];
  return { parent, dep: [...dep] };
}

// Ids are initiative-prefixed (TP-12), so the prefix stands in for the initiative.
const initiativeOf = (id: string): string => id.slice(0, id.lastIndexOf("-"));

const applyChange = (tasks: readonly Task[], change: EdgeChange): Map<string, Edges> => {
  const graph = new Map(tasks.map((task) => [task.id, readEdges(task)]));
  const current = graph.get(change.id) ?? { parent: null, dep: [] };
  graph.set(change.id, {
    parent: change.parent === undefined ? current.parent : change.parent,
    dep: change.dep === undefined ? current.dep : [...new Set(change.dep)],
  });
  return graph;
};

const unknownRefs = (graph: Map<string, Edges>, change: EdgeChange): EdgeError[] => {
  const { parent, dep } = graph.get(change.id) ?? { parent: null, dep: [] };
  const refs: { field: EdgeField; ref: string }[] = [
    ...(parent === null ? [] : [{ field: "parent" as const, ref: parent }]),
    ...dep.map((ref) => ({ field: "dep" as const, ref })),
  ];
  return refs
    .filter(({ ref }) => !graph.has(ref))
    .map(({ field, ref }) => ({ kind: "unknown-id", id: change.id, field, ref }));
};

const parentCycle = (graph: Map<string, Edges>, start: string): string[] | null => {
  const path = [start];
  let next = graph.get(start)?.parent ?? null;
  while (next !== null && !path.includes(next)) {
    path.push(next);
    next = graph.get(next)?.parent ?? null;
  }
  return next === start ? path : null;
};

const depCycle = (graph: Map<string, Edges>, start: string): string[] | null => {
  const visited = new Set<string>();
  const walk = (id: string, path: string[]): string[] | null => {
    for (const ref of graph.get(id)?.dep ?? []) {
      if (ref === start) return path;
      if (visited.has(ref)) continue;
      visited.add(ref);
      const found = walk(ref, [...path, ref]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
};

const cycles = (graph: Map<string, Edges>, start: string): EdgeError[] => {
  const found: [EdgeField, string[] | null][] = [
    ["parent", parentCycle(graph, start)],
    ["dep", depCycle(graph, start)],
  ];
  return found.flatMap(([field, ids]) => (ids ? [{ kind: "cycle" as const, field, ids }] : []));
};

/**
 * Checks a proposed edge change against the current tasks. Errors are fatal: an edge to an id
 * not in `tasks`, or a cycle through the changed task, listed as the ids on the cycle in edge
 * order from the changed task. A dep may cross initiatives. A parent in another initiative is
 * returned as a `cross-initiative-parent` warning, not an error, until the owner rules on it.
 */
export function checkEdges(tasks: readonly Task[], change: EdgeChange): EdgeCheck {
  const graph = applyChange(tasks, change);
  const errors = [...unknownRefs(graph, change), ...cycles(graph, change.id)];
  const parent = graph.get(change.id)?.parent ?? null;
  const warnings: CrossInitiativeParentWarning[] =
    parent !== null && initiativeOf(parent) !== initiativeOf(change.id)
      ? [{ kind: "cross-initiative-parent", id: change.id, parent }]
      : [];
  return { errors, warnings };
}
