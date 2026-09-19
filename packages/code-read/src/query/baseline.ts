import type { ReadModel } from "./model.js";
import { columnFor } from "./rollup.js";
import type { SnapshotRef } from "./schemas.js";
import { modelFor } from "./snapshot-ref.js";
import type { ReadSource } from "./source.js";
import { treeFor, type Tree } from "./tree.js";

/** A prior snapshot to measure deltas against, with the same role exclusions as the current one. */
export interface Baseline {
  model: ReadModel;
  tree: Tree;
}

export function openBaseline(source: ReadSource, ref: SnapshotRef | undefined, excludeRoles: readonly string[] = []): Baseline | undefined {
  if (ref === undefined) return undefined;
  const model = modelFor(source, ref);
  return { model, tree: treeFor(model, excludeRoles) };
}

// Matched by id only: following renames through the alias chain is TP-187's identity work.
export function baselineValue(baseline: Baseline, id: string, name: string): number | null {
  const node = baseline.tree.byId.get(id);
  return node ? columnFor(baseline.model, baseline.tree, name).valueOf(node).value : null;
}

/** The result fields every baseline-aware command reports; `comparable` is false across index versions. */
export function baselineFields(current: ReadModel, baseline: Baseline | undefined): { baselineSnapshotId?: number; comparable?: boolean } {
  if (!baseline) return {};
  return {
    baselineSnapshotId: baseline.model.snapshot.id,
    comparable: baseline.model.snapshot.indexVersion === current.snapshot.indexVersion,
  };
}

export function delta(value: number | null, before: number | null): number | null {
  return value !== null && before !== null ? value - before : null;
}
