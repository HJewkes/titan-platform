import type { ReadModel } from "./model.js";
import type { MetricDescriptor } from "./schemas.js";
import type { Tree, TreeNode } from "./tree.js";

/** Why a value is null: the rollup rule forbids one, the node has no measurement, the metric does not describe the node, or the snapshot lacks the metric. */
export type Missing = "no-rollup" | "not-measured" | "not-applicable" | "not-in-snapshot";

export interface MetricValue {
  value: number | null;
  missing?: Missing;
}

interface Aggregate {
  sum: number;
  count: number;
  max: number;
}

const KIND_RANK: Record<string, number> = { repo: 0, directory: 1, file: 2, symbol: 3 };
const EMPTY: Aggregate = { sum: 0, count: 0, max: -Infinity };

/** One metric over one tree: stored values where the catalogue says the metric applies, rollups above them. */
export interface Column {
  descriptor: MetricDescriptor | undefined;
  valueOf(node: TreeNode): MetricValue;
}

// Files before symbols: a metric stored on both rolls up from files only, so no value counts twice.
function leafKind(descriptor: MetricDescriptor): string | null {
  if (descriptor.appliesTo.includes("file")) return "file";
  return descriptor.appliesTo.includes("symbol") ? "symbol" : null;
}

function rank(kind: string): number {
  return KIND_RANK[kind] ?? Infinity;
}

function storedValue(descriptor: MetricDescriptor, values: ReadonlyMap<string, number | null> | undefined, id: string): MetricValue {
  const value = values?.get(id);
  if (value !== undefined && value !== null) return { value };
  if (value === undefined && descriptor.absent === "zero") return { value: 0 };
  return { value: null, missing: "not-measured" };
}

function merge(a: Aggregate, b: Aggregate): Aggregate {
  return { sum: a.sum + b.sum, count: a.count + b.count, max: Math.max(a.max, b.max) };
}

function finalValue(rule: MetricDescriptor["rollup"], agg: Aggregate): MetricValue {
  if (agg.count === 0) return { value: null, missing: "not-measured" };
  if (rule === "max") return { value: agg.max };
  if (rule === "mean") return { value: agg.sum / agg.count };
  return { value: agg.sum };
}

function buildColumn(model: ReadModel, name: string): Column {
  const descriptor = model.metricCatalogue.find((m) => m.name === name);
  if (!descriptor) return { descriptor, valueOf: () => ({ value: null, missing: "not-in-snapshot" }) };
  const values = model.metrics.get(name);
  const leaf = leafKind(descriptor);
  const aggregates = new Map<TreeNode, Aggregate>();
  const own = (node: TreeNode): MetricValue => storedValue(descriptor, values, node.ref.id);
  const aggregate = (node: TreeNode): Aggregate => {
    const cached = aggregates.get(node);
    if (cached) return cached;
    let agg = EMPTY;
    if (node.ref.kind === leaf) {
      const v = own(node).value;
      if (v !== null) agg = { sum: v, count: 1, max: v };
    }
    for (const child of node.children) if (rank(child.ref.kind) <= rank(leaf ?? "")) agg = merge(agg, aggregate(child));
    aggregates.set(node, agg);
    return agg;
  };
  const valueOf = (node: TreeNode): MetricValue => {
    if (node.stored && descriptor.appliesTo.includes(node.ref.kind)) return own(node);
    if (leaf === null || rank(node.ref.kind) >= rank(leaf)) return { value: null, missing: "not-applicable" };
    if (descriptor.rollup === "none") return { value: null, missing: "no-rollup" };
    return finalValue(descriptor.rollup, aggregate(node));
  };
  return { descriptor, valueOf };
}

const columns = new WeakMap<Tree, Map<string, Column>>();

/** The column for a metric over a tree, built once per tree and metric name. */
export function columnFor(model: ReadModel, tree: Tree, name: string): Column {
  let byName = columns.get(tree);
  if (!byName) columns.set(tree, (byName = new Map()));
  let column = byName.get(name);
  if (!column) byName.set(name, (column = buildColumn(model, name)));
  return column;
}

/** Whether a metric says anything about a node of this kind: stored on it, or rolled up into it. */
export function describesKind(descriptor: MetricDescriptor, kind: string): boolean {
  if (descriptor.appliesTo.includes(kind)) return true;
  const leaf = leafKind(descriptor);
  return leaf !== null && rank(kind) < rank(leaf);
}
