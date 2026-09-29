import type { MergeMethod } from "@titan-design/github";
import type { GateDecision, GatePolicy, PolicyRule } from "../gate-policy.js";
import type { SeatLookup } from "./seats.js";

export type MergeMode = "never" | "owner-gate" | "auto";

/** What a registration asks for; each field can only narrow what the seat allows. */
export interface RequestedPolicy {
  merge?: MergeMode;
  mergeMethod?: MergeMethod;
  reviewer?: string;
  priority?: number;
  fixer?: boolean;
}

export interface EffectivePolicy {
  merge: MergeMode;
  mergeMethod: MergeMethod;
  reviewer?: string;
  priority?: number;
  fixer: boolean;
  /** The seat that set the ceiling, or `none` for a repo no seat lists. */
  seat: string;
}

export class RegistrationRefused extends Error {
  override readonly name = "RegistrationRefused";
}

export const MERGE_ON_GREEN_GRANT = "merge-on-green-approve";
export const SHEPHERD_POLICY_TABLE = "shepherd-seat";

const MERGE_ORDER: readonly MergeMode[] = ["never", "owner-gate", "auto"];

function narrower(a: MergeMode, b: MergeMode): MergeMode {
  return MERGE_ORDER.indexOf(a) <= MERGE_ORDER.indexOf(b) ? a : b;
}

/** The seat default narrowed by the per-PR request; a registration never widens its seat. */
export function resolveEffectivePolicy(lookup: SeatLookup, requested: RequestedPolicy = {}): EffectivePolicy {
  if (lookup.kind === "denied") throw new RegistrationRefused(lookup.reason);
  const seat = lookup.kind === "seat" ? lookup.seat : undefined;
  const ceiling: MergeMode = seat?.grants.includes(MERGE_ON_GREEN_GRANT) ? "auto" : "owner-gate";
  return {
    merge: narrower(ceiling, requested.merge ?? ceiling),
    mergeMethod: requested.mergeMethod ?? "squash",
    ...(requested.reviewer !== undefined && { reviewer: requested.reviewer }),
    ...(requested.priority !== undefined && { priority: requested.priority }),
    fixer: seat !== undefined && requested.fixer !== false,
    seat: seat?.name ?? "none",
  };
}

/** `never` denies and everything else gates; T7 (TP-464) turns `auto` into an allow. */
export function shepherdGatePolicy(effective: EffectivePolicy): GatePolicy {
  const rule: PolicyRule = { table: SHEPHERD_POLICY_TABLE, rowId: effective.seat, version: 1 };
  return {
    decide: (action): GateDecision =>
      effective.merge === "never"
        ? { outcome: "deny", rule, reason: `seat ${effective.seat} policy never allows ${action}` }
        : { outcome: "gate", rule, reason: `seat ${effective.seat} policy ${effective.merge} waits for the owner on ${action}` },
  };
}
