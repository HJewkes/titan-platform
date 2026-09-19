import type { CommandArgs, CommandResult } from "./contract.js";
import { baselineFields, baselineValue, delta, openBaseline, type Baseline } from "./baseline.js";
import type { ReadModel } from "./model.js";
import { columnFor, describesKind } from "./rollup.js";
import type { NodeRef } from "./schemas.js";
import { modelFor } from "./snapshot-ref.js";
import { nodeNotFound, type ReadSource } from "./source.js";
import { peerStats } from "./stats.js";
import { treeFor, type Tree, type TreeNode } from "./tree.js";

type NodeGetResult = CommandResult<"node.get">;
type NodeMetric = NodeGetResult["metrics"][number];

function ancestorsOf(tree: Tree, node: TreeNode): NodeRef[] {
  const chain: NodeRef[] = [];
  for (let id = node.parentId; id !== null; ) {
    const parent = tree.byId.get(id)!;
    chain.push(parent.ref);
    id = parent.parentId;
  }
  return chain.reverse();
}

function childCounts(node: TreeNode): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const child of node.children) counts[child.ref.kind] = (counts[child.ref.kind] ?? 0) + 1;
  return counts;
}

function describeNode(node: TreeNode): NodeGetResult["node"] {
  const out: NodeGetResult["node"] = { ...node.ref };
  const stored = node.stored;
  if (!stored) return out;
  if (stored.language !== undefined) out.language = stored.language;
  if (stored.role !== undefined) out.role = stored.role;
  const { exported, signature, purpose } = stored.attrs;
  if (typeof exported === "boolean") out.exported = exported;
  if (typeof signature === "string") out.signature = signature;
  if (typeof purpose === "string") out.purpose = purpose;
  return out;
}

function metricNames(model: ReadModel, kind: string, requested: readonly string[]): string[] {
  if (requested.length > 0) return [...new Set(requested)];
  return model.metricCatalogue.filter((d) => describesKind(d, kind)).map((d) => d.name);
}

function measure(model: ReadModel, tree: Tree, node: TreeNode, name: string, baseline?: Baseline): NodeMetric {
  const column = columnFor(model, tree, name);
  const { value, missing } = column.valueOf(node);
  const d = column.descriptor;
  const metric: NodeMetric = {
    name,
    unit: d?.unit ?? null,
    direction: d?.direction ?? "neutral",
    rollup: d?.rollup ?? "none",
    value,
    ...(missing ? { missing } : {}),
    ...peerStats(column, tree, node, value),
  };
  if (!baseline) return metric;
  metric.baseline = baselineValue(baseline, node.ref.id, name);
  metric.delta = delta(value, metric.baseline);
  return metric;
}

/** `node.get`: one node of the synthesized hierarchy with its numbers in context. */
export function getNode(source: ReadSource, args: CommandArgs<"node.get">): NodeGetResult {
  const model = modelFor(source, args.snapshot);
  const tree = treeFor(model);
  const node = tree.byId.get(args.id);
  if (!node) throw nodeNotFound(args.id, model.snapshot.id);
  const baseline = openBaseline(source, args.baseline);
  return {
    snapshotId: model.snapshot.id,
    ...baselineFields(model, baseline),
    node: describeNode(node),
    ancestors: ancestorsOf(tree, node),
    childCounts: childCounts(node),
    metrics: metricNames(model, node.ref.kind, args.metrics).map((name) => measure(model, tree, node, name, baseline)),
  };
}
