/**
 * The `route_*` keys a dispatcher writes on its spawn row, defined once so the writer, the readout and the outcome
 * join cannot drift. The chosen profile is not here: it is the row's own `profile`.
 */

export const ROUTE_META_KEYS = [
  "route_mode",
  "route_source",
  "route_prior",
  "route_reason",
  "route_requested",
  "route_wanted",
  "route_workflow",
  "route_table",
  "route_facts",
  "route_candidate",
  "route_candidate_wanted",
] as const;
export type RouteMetaKey = (typeof ROUTE_META_KEYS)[number];

export const FACT_SOURCES = ["plan-slice", "plan", "req", "none"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export const FACT_NAMES = ["estimate", "done_when", "kind", "owns", "slice"] as const;
export type FactName = (typeof FACT_NAMES)[number];

/** Which facts a decision saw and where its owns came from, so the readout can measure fact coverage. */
export interface FactsNote {
  source: FactSource;
  present: FactName[];
  /** The task id was found in more than one initiative; the first was read. */
  ambiguous?: true;
}

export const ROUTE_SOURCES = [
  "auto",
  "routed",
  "agrees",
  "shadow",
  "override",
  "keep-role",
  "no-task",
  "table-error",
] as const;
export type RouteSource = (typeof ROUTE_SOURCES)[number];

export interface RouteDecision {
  mode: "off" | "shadow" | "on";
  source: RouteSource;
  /** The profile that runs. */
  profile: string;
  requested: string;
  prior?: string;
  reason?: string;
  /** The table's own pick, even when it is outside the tiers and so never applied. */
  wanted?: string;
  /** The class row the prior sent the task to. */
  workflow?: string;
  table?: string;
  facts?: FactsNote;
  candidate?: string;
  candidateWanted?: string;
  /** One line for the dispatcher's log when the decision changed, or would change, the profile. */
  note?: string;
}

/** The decision as `route_*` string fields; absent parts are left out rather than written empty. */
export function routeMeta(decision: RouteDecision): Partial<Record<RouteMetaKey, string>> {
  const values: Record<RouteMetaKey, string | undefined> = {
    route_mode: decision.mode,
    route_source: decision.source,
    route_prior: decision.prior,
    route_reason: decision.reason,
    route_requested: decision.requested,
    route_wanted: decision.wanted,
    route_workflow: decision.workflow,
    route_table: decision.table,
    route_facts: decision.facts === undefined ? undefined : JSON.stringify(decision.facts),
    route_candidate: decision.candidate,
    route_candidate_wanted: decision.candidateWanted,
  };
  const meta: Partial<Record<RouteMetaKey, string>> = {};
  for (const key of ROUTE_META_KEYS) {
    const value = values[key];
    if (value !== undefined) meta[key] = value;
  }
  return meta;
}
