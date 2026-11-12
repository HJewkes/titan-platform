import type { MergeFacts } from "@titan-design/authority";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import type { CiPolicy } from "@titan-design/session-read";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import type { CiPolicyClass } from "./ci-policy-class.js";
import { budgetAt } from "./ci-policy-guard.js";
import { ownerTierRows } from "./risk-tier.js";

/** `shepherd.gateReset.ownerTier` (TP-5406): absent means `shadow`, which records the rows and changes no outcome (Q-S2c). */
export type OwnerTierMode = "off" | "shadow" | "on";

/** The mode the merge-evidence step read, and the rows at its head; `off` stamps nothing. */
interface OwnerTierStamp {
  mode: Exclude<OwnerTierMode, "off">;
  rows: string[];
}

export interface OwnerTierField {
  /** Read back unvalidated from a stored record, so decide time parses the mode itself. */
  ownerTier?: OwnerTierStamp;
}

export interface OwnerTierWiring {
  /** The live `shepherd.gateReset.ownerTier`; absent means `shadow`. */
  ownerTier?: OwnerTierMode;
}

interface OwnerTierEvidence extends OwnerTierField {
  head: string;
  merge: MergeFacts;
  ciPolicy?: CiPolicy;
  ciPolicyClass?: CiPolicyClass;
}

const OWNER_TIER_REASON_PREFIX = "owner tier: ";

/** Recomputed from the head's own facts, so a stored record decides the same way at the same head. */
const rowsAt = (evidence: OwnerTierEvidence): string[] => ownerTierRows({ paths: evidence.merge.changedPaths, ciBudget: budgetAt(evidence, evidence.head) !== undefined });

export function ownerTierStamp(mode: OwnerTierMode | undefined, evidence: OwnerTierEvidence): OwnerTierField {
  const read = mode ?? "shadow";
  return read === "off" ? {} : { ownerTier: { mode: read, rows: rowsAt(evidence) } };
}

/** An absent stamp is a record from before the row, or one read under `off`; any stamp but a well-formed shadow reads as `on`. */
function stampedMode(stamp: unknown): OwnerTierMode {
  if (stamp === undefined) return "off";
  return isObjectLike(stamp) && stamp.mode === "shadow" ? "shadow" : "on";
}

/** Under `on`, a head with any owner-tier row gates on a guard row only the owner resolves. */
export function ownerTierGate(evidence: OwnerTierEvidence, rule: PolicyRule): GateDecision | undefined {
  if (stampedMode(evidence.ownerTier) !== "on") return undefined;
  const rows = rowsAt(evidence);
  return rows.length === 0 ? undefined : { outcome: "gate", rule, reason: `${OWNER_TIER_REASON_PREFIX}${rows.join("; ")}` };
}

/** Under `shadow`, an allow names the rows it would have gated on; a gate, or any other mode, is left as it is. */
export function ownerTierNoted(decision: GateDecision, evidence: OwnerTierEvidence): GateDecision {
  if (decision.outcome !== "allow" || stampedMode(evidence.ownerTier) !== "shadow") return decision;
  const rows = rowsAt(evidence);
  return rows.length === 0 ? decision : { ...decision, reason: `${decision.reason}; owner tier would gate: ${rows.join("; ")}` };
}
