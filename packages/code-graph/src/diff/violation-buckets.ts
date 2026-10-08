import type { CheckViolation } from "../check/types.js";
import { rebasedViolationKey, violationKey, type ViolationIdentity } from "../check/violation-key.js";

/** What bucketing reads from a violation: its identity and, when the rule measures one, its value and threshold. */
export type BucketableViolation = ViolationIdentity & Pick<CheckViolation, "value" | "threshold">;

export type ExcessChange = "worsened" | "improved" | "unchanged";

/**
 * How far past its threshold a violation sits; larger is worse for every rule: value over
 * threshold for a maximum, threshold over value for a minimum. Null when either is missing
 * or the ratio has no meaning.
 */
export function violationExcess(ruleType: string | undefined, value?: number, threshold?: number): number | null {
  if (value === undefined || threshold === undefined) return null;
  if (ruleType === "metric-min") return value > 0 ? threshold / value : null;
  return threshold > 0 ? value / threshold : null;
}

/** Worsened when the excess grew; null when either side has none, so an unmeasured pair is never called better or worse. */
export function compareExcess(before: number | null, after: number | null): ExcessChange | null {
  if (before === null || after === null) return null;
  if (after === before) return "unchanged";
  return after > before ? "worsened" : "improved";
}

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
 * Bucket two snapshots' violations as new, resolved, or unchanged, and an unchanged one as
 * worsened or improved when it moved further past or back toward its threshold
 * ({@link violationExcess}). `resolve` carries from-side ids into the to-snapshot, so a moved
 * file's violations stay unchanged; omitted, ids match as they are. `ruleTypeOf` names each
 * rule's type; omitted, every rule reads as a maximum. Needs no store.
 */
export function bucketViolations<V extends BucketableViolation>(
  from: readonly V[],
  to: readonly V[],
  resolve?: (id: string) => string,
  ruleTypeOf?: (ruleId: string) => string | undefined,
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
    const change = excessChange(fromV, toV, ruleTypeOf?.(toV.ruleId));
    if (change === "worsened") buckets.worsened.push(entry);
    else if (change === "improved") buckets.improved.push(entry);
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

function excessChange(from: BucketableViolation, to: BucketableViolation, ruleType: string | undefined): ExcessChange | null {
  return compareExcess(violationExcess(ruleType, from.value, from.threshold), violationExcess(ruleType, to.value, to.threshold));
}

function computeDelta(from: BucketableViolation, to: BucketableViolation): number | null {
  if (from.value === undefined || to.value === undefined) return null;
  return to.value - from.value;
}
