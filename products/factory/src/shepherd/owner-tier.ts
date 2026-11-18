import type { MergeFacts } from "@titan-design/authority";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import type { CiPolicy } from "@titan-design/session-read";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import type { CiPolicyClass } from "./ci-policy-class.js";
import { budgetAt } from "./ci-policy-guard.js";
import { adversaryRequired, type AttestVerdicts } from "./attest-evidence.js";
import type { KindRead } from "./registered-kind.js";
import { ownerTierRows, type AuthorityRead } from "./risk-tier.js";

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
  /** The adversary's Authority line at this head (TP-5407), stamped so decide time reads the value the evidence step read; absent where no adversary was required. */
  authorityLine?: AuthorityRead;
}

export interface OwnerTierWiring {
  /** The live `shepherd.gateReset.ownerTier`, its absent key already read as `shadow` by the config reader; unwired reads as `on`. */
  ownerTier?: OwnerTierMode;
}

interface OwnerTierEvidence extends OwnerTierField {
  head: string;
  merge: MergeFacts;
  ciPolicy?: CiPolicy;
  ciPolicyClass?: CiPolicyClass;
}

const OWNER_TIER_REASON_PREFIX = "owner tier: ";

const AUTHORITY_READS: readonly unknown[] = ["unchanged", "tightened", "widened", "missing"] satisfies AuthorityRead[];
const isAuthorityRead = (value: unknown): value is AuthorityRead => AUTHORITY_READS.includes(value);

/** A stored stamp is unvalidated: any value but a known one reads as `missing`, so a corrupt record keeps the owner gate. */
function stampedAuthority(stamp: unknown): AuthorityRead | undefined {
  if (stamp === undefined) return undefined;
  return isAuthorityRead(stamp) ? stamp : "missing";
}

/** Recomputed from the head's own facts, so a stored record decides the same way at the same head. */
const rowsAt = (evidence: OwnerTierEvidence): string[] => {
  const authorityLine = stampedAuthority(evidence.authorityLine);
  return ownerTierRows({ paths: evidence.merge.changedPaths, ciBudget: budgetAt(evidence, evidence.head) !== undefined, ...(authorityLine && { authorityLine }) });
};

/**
 * The adversary's Authority line the evidence step stamps: its value when an adversary was required, `missing` when none
 * carried one or the registration that says whether one was required could not be read, and undefined otherwise.
 */
export function authorityLineOf(attest: AttestVerdicts | undefined, registration: Pick<KindRead, "holdReason" | "unread"> | undefined): { authorityLine?: AuthorityRead } {
  const required = registration?.unread !== undefined || adversaryRequired(attest, registration?.holdReason);
  return required ? { authorityLine: attest?.adversary?.authority ?? "missing" } : {};
}

/** A route that lost its wiring passes `undefined`, so that fails closed as `on` rather than quietly reading `shadow`. */
export function ownerTierStamp(mode: OwnerTierMode | undefined, evidence: OwnerTierEvidence): OwnerTierField {
  const read = mode ?? "on";
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
