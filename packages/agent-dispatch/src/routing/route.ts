import { classifyTask, profileFor, type TaskFacts } from "./classify.js";
import type { FactsNote, RouteDecision, RouteSource } from "./meta.js";
import type { PriorRouting } from "./prior.js";
import type { WorkflowTable } from "./table.js";

/**
 * The spawn-time route: which implementer profile a spawn runs as, decided from the workflow table. Pure. Routing
 * picks a profile and never refuses: a missing table, missing facts or a pick outside the tiers keeps the request.
 */

export const AUTO_PROFILE = "auto";
/** The profile `auto` runs as whenever the table cannot place it. */
export const AUTO_FALLBACK = "bd-implementer";
/** Fix rounds stay on the profile they asked for: they are logged, never routed. */
export const DEFAULT_KEEP_ROLES: readonly string[] = ["fix-round"];

/** A linted table and its id for the decision log, such as `shape-v1@1a2b3c4d`. */
export interface RouteTable {
  table: WorkflowTable;
  id: string;
}

export interface RouteInput {
  mode: PriorRouting;
  requested: string;
  /** Undefined when the table could not be read or failed its lint; `tableProblem` says why. */
  table: RouteTable | undefined;
  tableProblem?: string;
  taskId?: string;
  role?: string;
  keepRoles?: readonly string[];
  override?: string;
  facts?: TaskFacts;
  factsNote?: FactsNote;
  /** A table evaluated beside the live one; its pick is recorded and never applied. */
  candidate?: RouteTable;
}

const FAMILIES = ["bd-", ""] as const;
export type ImplementerFamily = (typeof FAMILIES)[number];
type Tier = "lite" | "full";

const profileIn = (family: ImplementerFamily, tier: Tier) => `${family}implementer${tier === "lite" ? "-lite" : ""}`;

/** The family a requested profile belongs to, or undefined for a profile the router leaves alone. */
export function implementerFamily(profile: string): ImplementerFamily | undefined {
  if (profile === AUTO_PROFILE) return "bd-";
  return FAMILIES.find((family) => profile === profileIn(family, "lite") || profile === profileIn(family, "full"));
}

const TABLE_TIERS: Readonly<Record<string, Tier>> = { "bd-implementer-lite": "lite", "bd-implementer": "full" };

/** The table's pick at the caller's family, so `implementer` can become `implementer-lite` but never a bd profile. */
export function inFamily(wanted: string, family: ImplementerFamily): string | undefined {
  const tier = TABLE_TIERS[wanted];
  return tier === undefined ? undefined : profileIn(family, tier);
}

const keepsRole = (role: string | undefined, keepRoles: readonly string[]) =>
  role !== undefined && keepRoles.some((keep) => role === keep || role.startsWith(`${keep}-`));

function kept(input: RouteInput, source: RouteSource): RouteDecision {
  const decision: RouteDecision = {
    mode: input.mode,
    source,
    profile: input.requested === AUTO_PROFILE ? AUTO_FALLBACK : input.requested,
    requested: input.requested,
  };
  if (input.table !== undefined) decision.table = input.table.id;
  if (input.factsNote !== undefined) decision.facts = input.factsNote;
  return decision;
}

function classified(input: RouteInput, live: RouteTable, family: ImplementerFamily): RouteDecision {
  const facts = input.facts ?? { owns: [] };
  const { prior, reason } = classifyTask(live.table, facts);
  const wanted = profileFor(live.table, prior, facts.estimate);
  const applied = inFamily(wanted, family);
  const seen = { ...kept(input, "agrees"), prior, reason, wanted, workflow: live.table.priorWorkflow[prior] };
  if (input.requested === AUTO_PROFILE) return { ...seen, source: "auto", profile: applied ?? seen.profile };
  if (applied === undefined || applied === input.requested) return seen;
  const change = `${input.taskId}: ${input.requested} -> ${applied} (prior ${prior}: ${reason})`;
  return input.mode === "on"
    ? { ...seen, source: "routed", profile: applied, note: `route-change ${change}` }
    : { ...seen, source: "shadow", note: `would-route ${change}` };
}

function withCandidate(decision: RouteDecision, input: RouteInput): RouteDecision {
  const { candidate } = input;
  if (candidate === undefined) return decision;
  const facts = input.facts ?? { owns: [] };
  const { prior } = classifyTask(candidate.table, facts);
  return { ...decision, candidate: candidate.id, candidateWanted: profileFor(candidate.table, prior, facts.estimate) };
}

/**
 * The decision for one spawn, or undefined when the spawn is not routed: a profile outside the implementer family,
 * an explicit profile with routing off, or an explicit profile with no task. `auto` is the caller's own request to
 * route, so it classifies in every mode.
 */
export function routeSpawn(input: RouteInput): RouteDecision | undefined {
  const family = implementerFamily(input.requested);
  if (family === undefined) return undefined;
  const auto = input.requested === AUTO_PROFILE;
  if (!auto && input.mode === "off") return undefined;
  if (input.taskId === undefined) return auto ? kept(input, "no-task") : undefined;
  if (keepsRole(input.role, input.keepRoles ?? DEFAULT_KEEP_ROLES)) return kept(input, "keep-role");
  if (input.override !== undefined) return { ...kept(input, "override"), reason: `override ${input.override}` };
  if (input.table === undefined) return { ...kept(input, "table-error"), reason: input.tableProblem };
  return withCandidate(classified(input, input.table, family), input);
}
