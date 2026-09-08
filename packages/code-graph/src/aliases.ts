import type { EdgeKind, NodeRole } from "./types.js";

/**
 * Schema-healing aliases: deprecated or synonymous spellings mapped to the one
 * canonical name codewatch emits today. Two jobs:
 *
 *   1. Rename tolerance on snapshot diff — a metric/edge-kind renamed between an
 *      old snapshot and a new one is reconciled to its canonical name so it
 *      lines up instead of surfacing as a spurious add/remove.
 *   2. Config tolerance — an external `.codewatch/check.json` that spells a
 *      metric or role with a separator/plural variant loads with a deprecation
 *      warning and the canonical name, not a hard error.
 *
 * Seeds are conservative: only separator (`-`/`_`), singular/plural, and
 * unambiguous synonym variants of names codewatch actually produces. Add a real
 * historical rename here when one lands; nothing maps a name to a *different*
 * concept.
 */

const METRIC_ALIASES: ReadonlyMap<string, string> = new Map([
  ["lines", "loc"],
  ["lines_of_code", "loc"],
  ["fan-in", "fan_in"],
  ["fanin", "fan_in"],
  ["fan-out", "fan_out"],
  ["fanout", "fan_out"],
  ["nesting_depth", "max_nesting_depth"],
  ["max-nesting-depth", "max_nesting_depth"],
  ["lcom4", "lcom4_max"],
]);

const ROLE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["tests", "test"],
  ["spec", "test"],
  ["specs", "test"],
  ["fixtures", "fixture"],
  ["barrels", "barrel"],
]);

const EDGE_KIND_ALIASES: ReadonlyMap<string, string> = new Map([
  ["import", "imports"],
  ["call", "calls"],
  ["reference", "references"],
  ["re_exports", "re-exports"],
  ["reexports", "re-exports"],
  ["re-export", "re-exports"],
  ["depends_on", "depends-on"],
  ["dependson", "depends-on"],
]);

/** Canonical name for a deprecated alias, or `undefined` if `name` is not aliased. */
export function deprecatedTarget(
  map: ReadonlyMap<string, string>,
  name: string,
): string | undefined {
  return map.get(name);
}

export function canonicalMetricName(name: string): string {
  return METRIC_ALIASES.get(name) ?? name;
}

export function canonicalRole(name: string): NodeRole {
  return (ROLE_ALIASES.get(name) ?? name) as NodeRole;
}

export function canonicalEdgeKind(name: string): EdgeKind {
  return (EDGE_KIND_ALIASES.get(name) ?? name) as EdgeKind;
}

/** Canonical metric name for a deprecated alias, or `undefined`. */
export function metricAliasTarget(name: string): string | undefined {
  return deprecatedTarget(METRIC_ALIASES, name);
}

/** Canonical role for a deprecated alias, or `undefined`. */
export function roleAliasTarget(name: string): NodeRole | undefined {
  return deprecatedTarget(ROLE_ALIASES, name) as NodeRole | undefined;
}
