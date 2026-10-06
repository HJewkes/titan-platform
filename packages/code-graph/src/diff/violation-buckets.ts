import type { CheckViolation } from "../check/types.js";
import { rebasedViolationKey, violationKey, type ViolationIdentity } from "../check/violation-key.js";

/** What bucketing reads from a violation: its identity and, when the rule measures one, its value. */
export type BucketableViolation = ViolationIdentity & Pick<CheckViolation, "value">;

export interface UnchangedViolation<V extends BucketableViolation = CheckViolation> {
  from: V;
  to: V;
  delta: number | null;
}

export interface ViolationBuckets<V extends BucketableViolation = CheckViolation> {
  newViolations: V[];
  resolvedViolations: V[];
  unchanged: UnchangedViolation<V>[];
  worsened: UnchangedViolation<V>[];
  improved: UnchangedViolation<V>[];
}

/**
 * Bucket two snapshots' violations as new, resolved, or unchanged (worsened or improved
 * by value). `resolve` carries from-side ids into the to-snapshot, so a moved file's
 * violations stay unchanged; omitted, ids match as they are. Needs no store.
 */
export function bucketViolations<V extends BucketableViolation>(
  from: readonly V[],
  to: readonly V[],
  resolve?: (id: string) => string,
): ViolationBuckets<V> {
  const fromByKey = indexByKey(from, resolve);
  const toByKey = indexByKey(to);
  const buckets: ViolationBuckets<V> = { newViolations: [], resolvedViolations: [], unchanged: [], worsened: [], improved: [] };
  for (const [key, toV] of toByKey) {
    const fromV = fromByKey.get(key);
    if (!fromV) {
      buckets.newViolations.push(toV);
      continue;
    }
    const entry: UnchangedViolation<V> = { from: fromV, to: toV, delta: computeDelta(fromV, toV) };
    buckets.unchanged.push(entry);
    if (entry.delta !== null && entry.delta > 0) buckets.worsened.push(entry);
    else if (entry.delta !== null && entry.delta < 0) buckets.improved.push(entry);
  }
  for (const [key, fromV] of fromByKey) {
    if (!toByKey.has(key)) buckets.resolvedViolations.push(fromV);
  }
  return buckets;
}

function indexByKey<V extends BucketableViolation>(violations: readonly V[], resolve?: (id: string) => string): Map<string, V> {
  const out = new Map<string, V>();
  for (const v of violations) out.set(resolve ? rebasedViolationKey(v, resolve) : violationKey(v), v);
  return out;
}

function computeDelta(from: BucketableViolation, to: BucketableViolation): number | null {
  if (from.value === undefined || to.value === undefined) return null;
  return to.value - from.value;
}
