import { runChecks } from "../check/check.js";
import type { CheckRule } from "../check/types.js";
import { aliasChain } from "../identity/store-identity.js";
import type { CodeGraphStore } from "../store.js";
import { bucketViolations, type ViolationBuckets } from "./violation-buckets.js";

export type { UnchangedViolation } from "./violation-buckets.js";

export interface CheckDiff extends ViolationBuckets {
  fromSnapshotId: number;
  toSnapshotId: number;
  rulesEvaluated: number;
}

export interface DiffCheckResultsOptions {
  fromSnapshotId: number;
  toSnapshotId: number;
  rules: readonly CheckRule[];
}

/**
 * Run the rules on both snapshots and bucket each violation as new, resolved, or
 * unchanged, worsened when it moved further past its threshold and improved when it moved
 * back toward it. From-side ids follow the alias chain into the to-snapshot, so a moved
 * file's violations stay unchanged.
 */
export function diffCheckResults(store: CodeGraphStore, options: DiffCheckResultsOptions): CheckDiff {
  const from = runChecks(store, { snapshotId: options.fromSnapshotId, rules: options.rules });
  const to = runChecks(store, { snapshotId: options.toSnapshotId, rules: options.rules });
  const chain = aliasChain(store, options.fromSnapshotId, options.toSnapshotId);
  const ruleTypes = new Map(options.rules.map((r) => [r.id, r.type]));
  return {
    fromSnapshotId: options.fromSnapshotId,
    toSnapshotId: options.toSnapshotId,
    rulesEvaluated: options.rules.length,
    ...bucketViolations(from.violations, to.violations, chain.resolve, (id) => ruleTypes.get(id)),
  };
}
