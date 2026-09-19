import { aliasChain } from "../identity/store-identity.js";
import type { CodeGraphStore } from "../store.js";
import { buildRuleContext } from "./context.js";
import { runRule } from "./rules.js";
import type { CheckResult, CheckRule, CheckViolation } from "./types.js";

export interface RunChecksOptions {
  snapshotId: number;
  rules: readonly CheckRule[];
  baselineSnapshotId?: number;
}

export function runChecks(store: CodeGraphStore, options: RunChecksOptions): CheckResult {
  const ctx = buildRuleContext(store, options.snapshotId);
  const violations: CheckViolation[] = [];
  for (const rule of options.rules) {
    violations.push(...runRule(rule, ctx));
  }
  if (options.baselineSnapshotId) {
    const baselineKeys = collectBaselineKeys(store, options.baselineSnapshotId, options.snapshotId, options.rules);
    for (const v of violations) {
      if (baselineKeys.has(violationKey(v))) v.isCarryover = true;
    }
  }
  const counts = countByOriginAndSeverity(violations);
  return {
    snapshotId: options.snapshotId,
    baselineSnapshotId: options.baselineSnapshotId,
    rulesEvaluated: options.rules.length,
    nodesEvaluated: ctx.nodes.length,
    violations,
    ...counts,
    passed: counts.newErrors === 0,
  };
}

/** Baseline violation keys in the checked snapshot's id space, so a moved file's violations carry over. */
function collectBaselineKeys(
  store: CodeGraphStore,
  baselineSnapshotId: number,
  snapshotId: number,
  rules: readonly CheckRule[],
): Set<string> {
  const ctx = buildRuleContext(store, baselineSnapshotId);
  const chain = aliasChain(store, baselineSnapshotId, snapshotId);
  const keys = new Set<string>();
  for (const rule of rules) {
    for (const v of runRule(rule, ctx)) keys.add(rebasedViolationKey(v, chain.resolve));
  }
  return keys;
}

/** Identity of a violation across snapshots: severity, value and message may change, the key does not. */
export function violationKey(v: CheckViolation): string {
  return v.destinationId ? `${v.ruleId}|${v.nodeId}|${v.destinationId}` : `${v.ruleId}|${v.nodeId}`;
}

/** {@link violationKey} with both node ids carried into another snapshot's id space; unmoved ids key as before. */
export function rebasedViolationKey(v: CheckViolation, resolve: (id: string) => string): string {
  const destinationId = v.destinationId ? resolve(v.destinationId) : v.destinationId;
  return violationKey({ ...v, nodeId: resolve(v.nodeId), destinationId });
}

interface Counts {
  newErrors: number;
  newWarnings: number;
  carryoverErrors: number;
  carryoverWarnings: number;
}

function countByOriginAndSeverity(violations: readonly CheckViolation[]): Counts {
  const counts: Counts = { newErrors: 0, newWarnings: 0, carryoverErrors: 0, carryoverWarnings: 0 };
  for (const v of violations) {
    const isError = v.severity === "error";
    if (v.isCarryover) {
      if (isError) counts.carryoverErrors++;
      else counts.carryoverWarnings++;
    } else {
      if (isError) counts.newErrors++;
      else counts.newWarnings++;
    }
  }
  return counts;
}
