import { runChecks, violationKey } from "../check/check.js";
import type { CheckRule, CheckViolation } from "../check/types.js";
import type { CodeGraphStore } from "../store.js";

export interface UnchangedViolation {
  from: CheckViolation;
  to: CheckViolation;
  delta: number | null;
}

export interface CheckDiff {
  fromSnapshotId: number;
  toSnapshotId: number;
  rulesEvaluated: number;
  newViolations: CheckViolation[];
  resolvedViolations: CheckViolation[];
  unchanged: UnchangedViolation[];
  worsened: UnchangedViolation[];
  improved: UnchangedViolation[];
}

export interface DiffCheckResultsOptions {
  fromSnapshotId: number;
  toSnapshotId: number;
  rules: readonly CheckRule[];
}

type Buckets = Pick<CheckDiff, "newViolations" | "resolvedViolations" | "unchanged" | "worsened" | "improved">;

/** Run the rules on both snapshots and bucket each violation as new, resolved, or unchanged (worsened or improved by value). */
export function diffCheckResults(store: CodeGraphStore, options: DiffCheckResultsOptions): CheckDiff {
  const from = runChecks(store, { snapshotId: options.fromSnapshotId, rules: options.rules });
  const to = runChecks(store, { snapshotId: options.toSnapshotId, rules: options.rules });
  return {
    fromSnapshotId: options.fromSnapshotId,
    toSnapshotId: options.toSnapshotId,
    rulesEvaluated: options.rules.length,
    ...bucketViolations(indexByKey(from.violations), indexByKey(to.violations)),
  };
}

function bucketViolations(
  fromByKey: Map<string, CheckViolation>,
  toByKey: Map<string, CheckViolation>,
): Buckets {
  const buckets: Buckets = { newViolations: [], resolvedViolations: [], unchanged: [], worsened: [], improved: [] };
  for (const [key, toV] of toByKey) {
    const fromV = fromByKey.get(key);
    if (!fromV) {
      buckets.newViolations.push(toV);
      continue;
    }
    const delta = computeDelta(fromV, toV);
    const entry: UnchangedViolation = { from: fromV, to: toV, delta };
    buckets.unchanged.push(entry);
    if (delta !== null && delta > 0) buckets.worsened.push(entry);
    else if (delta !== null && delta < 0) buckets.improved.push(entry);
  }
  for (const [key, fromV] of fromByKey) {
    if (!toByKey.has(key)) buckets.resolvedViolations.push(fromV);
  }
  return buckets;
}

function indexByKey(violations: readonly CheckViolation[]): Map<string, CheckViolation> {
  const out = new Map<string, CheckViolation>();
  for (const v of violations) out.set(violationKey(v), v);
  return out;
}

function computeDelta(from: CheckViolation, to: CheckViolation): number | null {
  if (from.value === undefined || to.value === undefined) return null;
  return to.value - from.value;
}
