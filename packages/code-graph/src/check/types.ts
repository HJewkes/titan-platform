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

/** Flags nodes whose value sits strictly above the given percentile of the metric over every node of the kind. */
export interface MetricOutlierRule {
  type: "metric-outlier";
  id: string;
  metric: string;
  kind: NodeKind;
  /** 50 to 100; the threshold interpolates linearly between the two nearest ranked values. */
  percentile: number;
  /** Fewest nodes that must carry the metric before any is judged; defaults to 20. */
  minSample?: number;
  /** A node is flagged only if its value also exceeds this absolute floor, guarding sparse metrics whose percentile sits at or near zero. */
  floor?: number;
  /** When true, rank and gate on the pool of carriers with a non-zero value only; zero-valued nodes are never flagged. */
  rankNonZero?: boolean;
  severity?: Severity;
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
  | MetricOutlierRule
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
  /** Repo-relative file the violation sits in; a symbol's parent file. */
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
  /** One line a reader can check without re-running the rule, such as `loc=412 (max 350)`. */
  evidence?: string;
  tool?: string;
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
