import { metricAliasTarget, roleAliasTarget } from "../aliases.js";
import type {
  CheckRule,
  ForbidImportRule,
  LayeredDepsRule,
  MetricMaxRule,
  MetricMinRule,
  MetricOutlierRule,
  MetricProductMaxRule,
  NoInternalOnlyBarrelsRule,
  Severity,
} from "./types.js";
import type { NodeKind, NodeRole } from "../types.js";

export interface ValidateRulesOptions {
  /** Called with a human-readable message when a deprecated alias is healed. */
  onWarn?: (message: string) => void;
}

type Warn = (message: string) => void;

export function validateRules(
  input: unknown,
  options: ValidateRulesOptions = {},
): readonly CheckRule[] {
  if (!input || typeof input !== "object") {
    throw new Error("rules file must be an object with a `rules` array");
  }
  const obj = input as { rules?: unknown };
  if (!Array.isArray(obj.rules)) {
    throw new Error("rules file must have a `rules` array");
  }
  const warn: Warn = options.onWarn ?? (() => {});
  return obj.rules.map((r, i) => validateRule(r, i, warn));
}

/** Heal a deprecated metric name to its canonical form, warning if renamed. */
function healMetricName(name: string, ruleId: string, warn: Warn): string {
  const target = metricAliasTarget(name);
  if (target) {
    warn(`${ruleId}: metric "${name}" is deprecated — using "${target}"`);
    return target;
  }
  return name;
}

function validateRule(raw: unknown, index: number, warn: Warn): CheckRule {
  if (!raw || typeof raw !== "object") {
    throw new Error(`rule[${index}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) {
    throw new Error(`rule[${index}] missing string id`);
  }
  if (typeof r.type !== "string") {
    throw new Error(`rule[${index}] (${r.id}) missing string type`);
  }
  switch (r.type) {
    case "metric-max":
      return assertMetricMax(r, warn);
    case "metric-min":
      return assertMetricMin(r, warn);
    case "metric-product-max":
      return assertMetricProductMax(r, warn);
    case "metric-outlier":
      return assertMetricOutlier(r, warn);
    case "forbid-import":
      return assertForbidImport(r);
    case "layered-deps":
      return assertLayeredDeps(r);
    case "no-internal-only-barrels":
      return assertNoInternalOnlyBarrels(r);
    default:
      throw new Error(`rule[${index}] (${r.id}) unknown type "${r.type}"`);
  }
}

function assertNoInternalOnlyBarrels(
  r: Record<string, unknown>,
): NoInternalOnlyBarrelsRule {
  if (!Array.isArray(r.packageRoots) || r.packageRoots.length === 0) {
    throw new Error(
      `${r.id}: packageRoots must be a non-empty array of path-prefix strings`,
    );
  }
  for (const p of r.packageRoots) {
    if (typeof p !== "string" || !p) {
      throw new Error(`${r.id}: each packageRoots entry must be a non-empty string`);
    }
  }
  return {
    type: "no-internal-only-barrels",
    id: r.id as string,
    packageRoots: r.packageRoots as string[],
    severity: r.severity as Severity | undefined,
    exclude: parseStringArray(r.exclude),
  };
}

function assertLayeredDeps(r: Record<string, unknown>): LayeredDepsRule {
  if (!Array.isArray(r.layers) || r.layers.length < 2) {
    throw new Error(`${r.id}: layers must be an array of 2+ string arrays`);
  }
  for (const layer of r.layers) {
    if (!Array.isArray(layer) || !layer.every((p) => typeof p === "string")) {
      throw new Error(`${r.id}: each layer must be a string[]`);
    }
    if (layer.length === 0) {
      throw new Error(`${r.id}: empty layers not allowed`);
    }
  }
  const seen = new Set<string>();
  for (const layer of r.layers as string[][]) {
    for (const pkg of layer) {
      if (seen.has(pkg)) {
        throw new Error(`${r.id}: package "${pkg}" appears in more than one layer`);
      }
      seen.add(pkg);
    }
  }
  return {
    type: "layered-deps",
    id: r.id as string,
    layers: r.layers as string[][],
    severity: r.severity as Severity | undefined,
  };
}

function assertMetricProductMax(
  r: Record<string, unknown>,
  warn: Warn,
): MetricProductMaxRule {
  if (!Array.isArray(r.metrics) || r.metrics.length < 2) {
    throw new Error(`${r.id}: metrics must be an array of 2+ metric names`);
  }
  if (!r.metrics.every((m): m is string => typeof m === "string")) {
    throw new Error(`${r.id}: metrics must be strings`);
  }
  if (typeof r.max !== "number") {
    throw new Error(`${r.id}: max must be a number`);
  }
  const ruleId = r.id as string;
  return {
    type: "metric-product-max",
    id: ruleId,
    metrics: r.metrics.map((m) => healMetricName(m, ruleId, warn)),
    max: r.max,
    kind: r.kind as MetricProductMaxRule["kind"],
    severity: r.severity as Severity | undefined,
    exclude: parseStringArray(r.exclude),
    excludeRoles: parseRoleArray(ruleId, r.excludeRoles, warn),
  };
}

function assertMetricMax(r: Record<string, unknown>, warn: Warn): MetricMaxRule {
  if (typeof r.metric !== "string") throw new Error(`${r.id}: metric must be a string`);
  if (typeof r.max !== "number") throw new Error(`${r.id}: max must be a number`);
  const ruleId = r.id as string;
  return {
    type: "metric-max",
    id: ruleId,
    metric: healMetricName(r.metric, ruleId, warn),
    max: r.max,
    kind: r.kind as MetricMaxRule["kind"],
    severity: r.severity as Severity | undefined,
    exclude: parseStringArray(r.exclude),
    excludeRoles: parseRoleArray(ruleId, r.excludeRoles, warn),
  };
}

function assertMetricMin(r: Record<string, unknown>, warn: Warn): MetricMinRule {
  if (typeof r.metric !== "string") throw new Error(`${r.id}: metric must be a string`);
  if (typeof r.min !== "number") throw new Error(`${r.id}: min must be a number`);
  const ruleId = r.id as string;
  return {
    type: "metric-min",
    id: ruleId,
    metric: healMetricName(r.metric, ruleId, warn),
    min: r.min,
    kind: r.kind as MetricMinRule["kind"],
    severity: r.severity as Severity | undefined,
    exclude: parseStringArray(r.exclude),
    excludeRoles: parseRoleArray(ruleId, r.excludeRoles, warn),
  };
}

const NODE_KINDS: ReadonlySet<NodeKind> = new Set(["package", "module", "file", "symbol", "external"]);

function assertMetricOutlier(r: Record<string, unknown>, warn: Warn): MetricOutlierRule {
  if (typeof r.metric !== "string") throw new Error(`${r.id}: metric must be a string`);
  if (typeof r.kind !== "string" || !NODE_KINDS.has(r.kind as NodeKind)) {
    throw new Error(`${r.id}: kind must be one of ${[...NODE_KINDS].join(", ")}`);
  }
  if (typeof r.percentile !== "number" || r.percentile < 50 || r.percentile > 100) {
    throw new Error(`${r.id}: percentile must be a number from 50 to 100`);
  }
  if (r.minSample !== undefined && (!Number.isInteger(r.minSample) || (r.minSample as number) < 1)) {
    throw new Error(`${r.id}: minSample must be a positive integer`);
  }
  if (r.floor !== undefined && (typeof r.floor !== "number" || !Number.isFinite(r.floor) || r.floor < 0)) {
    throw new Error(`${r.id}: floor must be a non-negative finite number`);
  }
  if (r.rankNonZero !== undefined && typeof r.rankNonZero !== "boolean") {
    throw new Error(`${r.id}: rankNonZero must be a boolean`);
  }
  const ruleId = r.id as string;
  return {
    type: "metric-outlier",
    id: ruleId,
    metric: healMetricName(r.metric, ruleId, warn),
    kind: r.kind as NodeKind,
    percentile: r.percentile,
    minSample: r.minSample as number | undefined,
    floor: r.floor as number | undefined,
    rankNonZero: r.rankNonZero as boolean | undefined,
    severity: r.severity as Severity | undefined,
  };
}

function assertForbidImport(r: Record<string, unknown>): ForbidImportRule {
  if (typeof r.from !== "string") throw new Error(`${r.id}: from must be a string`);
  if (typeof r.to !== "string") throw new Error(`${r.id}: to must be a string`);
  return {
    type: "forbid-import",
    id: r.id as string,
    from: r.from,
    to: r.to,
    severity: r.severity as Severity | undefined,
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined;
}

const ROLE_VALUES: ReadonlySet<NodeRole> = new Set([
  "test",
  "fixture",
  "barrel",
  "types",
  "config",
  "entry",
  "source",
]);

function parseRoleArray(
  ruleId: string,
  value: unknown,
  warn: Warn,
): NodeRole[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${ruleId}: excludeRoles must be an array`);
  }
  return value.map((entry) => healRole(entry, ruleId, warn));
}

/** Heal a deprecated role alias to canonical; throw only on genuinely-unknown. */
function healRole(entry: unknown, ruleId: string, warn: Warn): NodeRole {
  if (typeof entry === "string" && ROLE_VALUES.has(entry as NodeRole)) {
    return entry as NodeRole;
  }
  if (typeof entry === "string") {
    const target = roleAliasTarget(entry);
    if (target) {
      warn(`${ruleId}: role "${entry}" is deprecated — using "${target}"`);
      return target;
    }
  }
  throw new Error(
    `${ruleId}: unknown role "${entry}" — valid: ${[...ROLE_VALUES].join(", ")}`,
  );
}
