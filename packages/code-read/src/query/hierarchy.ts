import { HIERARCHY_ROW_CAP } from "./contract-nodes.js";
import type { CommandArgs, CommandResult } from "./contract.js";
import { baselineFields, baselineValue, delta, openBaseline, type Baseline } from "./baseline.js";
import { columnFor, type Column } from "./rollup.js";
import { modelFor } from "./snapshot-ref.js";
import { nodeNotFound, type ReadSource } from "./source.js";
import { REPO_ID, treeFor, type TreeNode } from "./tree.js";

type HierarchyResult = CommandResult<"hierarchy.get">;
type HierarchyRow = HierarchyResult["nodes"][number];

/** Breadth-first to `depth`, so a truncated answer keeps the levels a treemap draws first. */
function collectRows(root: TreeNode, depth: number, includeSymbols: boolean): { rows: TreeNode[]; truncated: boolean } {
  const rows: TreeNode[] = [];
  const queue: TreeNode[] = [root];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    if (rows.length === HIERARCHY_ROW_CAP) return { rows, truncated: true };
    rows.push(node);
    if (node.depth - root.depth >= depth) continue;
    for (const child of node.children) if (includeSymbols || child.ref.kind !== "symbol") queue.push(child);
  }
  return { rows, truncated: false };
}

function toRow(node: TreeNode, rootDepth: number, columns: readonly Column[], names: readonly string[], baseline?: Baseline): HierarchyRow {
  const row: HierarchyRow = { ...node.ref, parentId: node.parentId, depth: node.depth - rootDepth, childCount: node.children.length, values: {} };
  if (node.stored?.role !== undefined) row.role = node.stored.role;
  const missing: Record<string, string> = {};
  const deltas: Record<string, number | null> = {};
  names.forEach((name, i) => {
    const { value, missing: reason } = columns[i]!.valueOf(node);
    row.values[name] = value;
    if (reason) missing[name] = reason;
    if (!baseline) return;
    deltas[name] = delta(value, baselineValue(baseline, node.ref.id, name));
  });
  if (Object.keys(missing).length > 0) row.missing = missing;
  if (baseline) row.deltas = deltas;
  return row;
}

/** `hierarchy.get`: a flat, shallowest-first slice of the synthesized tree with per-row metric values. */
export function getHierarchy(source: ReadSource, args: CommandArgs<"hierarchy.get">): HierarchyResult {
  const model = modelFor(source, args.snapshot);
  const tree = treeFor(model, args.exclude_roles);
  const root = tree.byId.get(args.root ?? REPO_ID);
  if (!root) throw nodeNotFound(args.root ?? REPO_ID, model.snapshot.id);
  const baseline = openBaseline(source, args.baseline, args.exclude_roles);
  const names = [...new Set(args.metrics)];
  const columns = names.map((name) => columnFor(model, tree, name));
  const { rows, truncated } = collectRows(root, args.depth, args.include_symbols);
  const nodes = rows.map((node) => toRow(node, root.depth, columns, names, baseline));
  return { snapshotId: model.snapshot.id, ...baselineFields(model, baseline), nodes, truncated };
}
