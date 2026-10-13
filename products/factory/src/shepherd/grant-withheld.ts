import type { FixProofUnverified } from "./fix-proof.js";

/**
 * Which half of the merge-on-green-approve grant a MERGE lacked (TP-2658): the run policy's merge when it is not `auto`, and,
 * in evidence recorded before TP-2660 b, the head's unverified fix-proof standing. Null means that half was met.
 */
interface GrantWithheld {
  policy: string | null;
  proof: string | null;
}

/** Merge evidence, its input and what decides on it carry this; set when `seatGrants` lacks merge-on-green-approve. */
export interface GrantWithheldField {
  grantWithheld?: GrantWithheld;
}

export interface GrantStanding {
  unverified?: FixProofUnverified;
  /** Why the fix-proof read proves nothing, as the sh-fix-proof step recorded it. */
  reason?: string;
}

const WITHHELD_PREFIX = "merge-on-green-approve withheld: ";
const UNRECORDED = "the cause was not recorded at this head";

/**
 * Only the policy half can withhold the grant now: an unverified proof is recorded, not gated (decision 303, TP-2660 b). `proof`
 * stays in the shape because evidence recorded before then may carry it.
 */
export function grantWithheldOf(merge: string): GrantWithheld | undefined {
  return merge === "auto" ? undefined : { policy: merge, proof: null };
}

/** The head's unverified fix-proof standing and its read reason, as the merge evidence records it; undefined when the proof stands. */
export function proofUnverifiedOf(standing: GrantStanding): string | undefined {
  return standing.unverified === undefined ? undefined : `${standing.unverified}${standing.reason ? ` (${standing.reason})` : ""}`;
}

/**
 * Free text the fix-proof read recorded, made inert inside a gate reason: resync and why-asked split a reason on "; " and read
 * `MRG-AU-<row> unmet:` parts, so a read reason holding either would forge an unmet row.
 */
function inert(text: string): string {
  return text.replace(/[;\r\n]+/g, ",").replace(/MRG-AU-/gi, "MRG-AU ");
}

/** The clause a gate reason carries, e.g. `merge-on-green-approve withheld: proof standing unverified: unread (...)`. */
function grantWithheldClause(withheld: GrantWithheld | undefined): string {
  const halves = [withheld?.policy && `policy merge ${inert(withheld.policy)}, not auto`, withheld?.proof && `proof standing unverified: ${inert(withheld.proof)}`].filter(Boolean);
  return `${WITHHELD_PREFIX}${halves.length > 0 ? halves.join(" and ") : UNRECORDED}`;
}

const GRANT_CONDITION = "seat-grants-merge-on-green-approve";

/** An unmet grant names which half failed, so the owner is never shown the bare condition (TP-2658). */
export function withGrantWithheld(reason: string, evidence: GrantWithheldField): string {
  return reason.includes(GRANT_CONDITION) ? `${reason}; ${grantWithheldClause(evidence.grantWithheld)}` : reason;
}

/** The field alone, absent when nothing was withheld, so a record spreads it without an undefined key. */
export function grantWithheldField(source: GrantWithheldField): GrantWithheldField {
  return source.grantWithheld ? { grantWithheld: source.grantWithheld } : {};
}

/** The withheld halves named in a gate reason, read up to a later `read closed:` clause; undefined when the reason has none. */
export function withheldInReason(reason: string): string | undefined {
  const at = reason.indexOf(WITHHELD_PREFIX);
  if (at < 0) return undefined;
  return reason.slice(at + WITHHELD_PREFIX.length).split("; read closed: ")[0];
}
