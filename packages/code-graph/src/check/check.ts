import { aliasChain } from "../identity/store-identity.js";
import type { CodeGraphStore } from "../store.js";
import { buildRuleContext, type RuleStore } from "./context.js";
import { runRule } from "./rules.js";
import type { CheckResult, CheckRule, CheckViolation } from "./types.js";
import { rebasedViolationKey, violationKey } from "./violation-key.js";

export { rebasedViolationKey, violationKey } from "./violation-key.js";

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
    const baseline = collectBaseline(store, options.baselineSnapshotId, options.snapshotId, options.rules);
    for (const v of violations) {
      if (isKnown(v, baseline)) v.isCarryover = true;
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

/** Every rule's violations in one snapshot with no baseline; needs only the three whole-snapshot reads. */
export function snapshotViolations(store: RuleStore, snapshotId: number, rules: readonly CheckRule[]): CheckViolation[] {
  const ctx = buildRuleContext(store, snapshotId);
  return rules.flatMap((rule) => runRule(rule, ctx));
}

interface Baseline {
  keys: Set<string>;
  /** Per rule, each baseline cycle's member ids in the checked snapshot's id space. */
  cycles: Map<string, Set<string>[]>;
}

/** A cycle is known when one baseline cycle of its rule holds every member, so a shrunk or split cycle carries over. */
function isKnown(v: CheckViolation, baseline: Baseline): boolean {
  if (baseline.keys.has(violationKey(v))) return true;
  const members = v.members;
  if (!members) return false;
  return (baseline.cycles.get(v.ruleId) ?? []).some((known) => members.every((m) => known.has(m)));
}

/** Baseline violations in the checked snapshot's id space, so a moved file's violations carry over. */
function collectBaseline(
  store: CodeGraphStore,
  baselineSnapshotId: number,
  snapshotId: number,
  rules: readonly CheckRule[],
): Baseline {
  const ctx = buildRuleContext(store, baselineSnapshotId);
  const chain = aliasChain(store, baselineSnapshotId, snapshotId);
  const baseline: Baseline = { keys: new Set(), cycles: new Map() };
  for (const rule of rules) {
    for (const v of runRule(rule, ctx)) {
      baseline.keys.add(rebasedViolationKey(v, chain.resolve));
      if (v.members) addCycle(baseline.cycles, v.ruleId, new Set(v.members.map(chain.resolve)));
    }
  }
  return baseline;
}

function addCycle(cycles: Map<string, Set<string>[]>, ruleId: string, members: Set<string>): void {
  const list = cycles.get(ruleId);
  if (list) list.push(members);
  else cycles.set(ruleId, [members]);
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
