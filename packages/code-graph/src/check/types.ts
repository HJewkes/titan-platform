import type { NodeKind, NodeRole } from "../types.js";

export type Severity = "error" | "warning";

export interface MetricMaxRule {
  type: "metric-max";
  id: string;
  metric: string;
  max: number;
  kind?: NodeKind;
  severity?: Severity;
  exclude?: string[];
  excludeRoles?: NodeRole[];
}

export interface MetricMinRule {
  type: "metric-min";
  id: string;
  metric: string;
  min: number;
  kind?: NodeKind;
  severity?: Severity;
  exclude?: string[];
  excludeRoles?: NodeRole[];
}

export interface MetricProductMaxRule {
  type: "metric-product-max";
  id: string;
  metrics: string[];
  max: number;
  kind?: NodeKind;
  severity?: Severity;
  exclude?: string[];
  excludeRoles?: NodeRole[];
}

export interface ForbidImportRule {
  type: "forbid-import";
  id: string;
  from: string;
  to: string;
  severity?: Severity;
}

export interface LayeredDepsRule {
  type: "layered-deps";
  id: string;
  layers: string[][];
  severity?: Severity;
}

export interface NoInternalOnlyBarrelsRule {
  type: "no-internal-only-barrels";
  id: string;
  /** Path prefixes marking package roots; node ids carry no intrinsic package membership. */
  packageRoots: string[];
  severity?: Severity;
  /** Globs or substrings to skip, such as CLI bin entries the role classifier calls barrels. */
  exclude?: string[];
}

export type CheckRule =
  | MetricMaxRule
  | MetricMinRule
  | MetricProductMaxRule
  | ForbidImportRule
  | LayeredDepsRule
  | NoInternalOnlyBarrelsRule;

export interface CheckRulesFile {
  rules: CheckRule[];
}

export interface CheckViolation {
  ruleId: string;
  severity: Severity;
  nodeId: string;
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
  destinationId?: string;
  isCarryover?: boolean;
}

export interface CheckResult {
  snapshotId: number;
  baselineSnapshotId?: number;
  rulesEvaluated: number;
  nodesEvaluated: number;
  violations: CheckViolation[];
  newErrors: number;
  newWarnings: number;
  carryoverErrors: number;
  carryoverWarnings: number;
  passed: boolean;
}
