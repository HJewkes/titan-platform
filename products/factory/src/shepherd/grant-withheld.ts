import type { FixProofUnverified } from "./fix-proof.js";

/**
 * Which half of the merge-on-green-approve grant a MERGE lacked (TP-2658): the run policy's merge when it is not `auto`, and
 * the head's fix-proof standing with the read's reason when the proof is unverified. Null means that half was met.
 */
export interface GrantWithheld {
  policy: string | null;
  proof: string | null;
}

export interface GrantStanding {
  unverified?: FixProofUnverified;
  /** Why the fix-proof read proves nothing, as the sh-fix-proof step recorded it. */
  reason?: string;
}

const WITHHELD_PREFIX = "merge-on-green-approve withheld: ";
const UNRECORDED = "the cause was not recorded at this head";

export function grantWithheldOf(merge: string, standing: GrantStanding): GrantWithheld | undefined {
  const policy = merge === "auto" ? null : merge;
  const proof = standing.unverified === undefined ? null : `${standing.unverified}${standing.reason ? ` (${standing.reason})` : ""}`;
  return policy === null && proof === null ? undefined : { policy, proof };
}

/** The clause a gate reason carries, e.g. `merge-on-green-approve withheld: proof standing unverified: unread (...)`. */
export function grantWithheldClause(withheld: GrantWithheld | undefined): string {
  const halves = [withheld?.policy && `policy merge ${withheld.policy}, not auto`, withheld?.proof && `proof standing unverified: ${withheld.proof}`].filter(Boolean);
  return `${WITHHELD_PREFIX}${halves.length > 0 ? halves.join(" and ") : UNRECORDED}`;
}

/** The withheld halves named in a gate reason, read up to a later `read closed:` clause; undefined when the reason has none. */
export function withheldInReason(reason: string): string | undefined {
  const at = reason.indexOf(WITHHELD_PREFIX);
  if (at < 0) return undefined;
  return reason.slice(at + WITHHELD_PREFIX.length).split("; read closed: ")[0];
}
