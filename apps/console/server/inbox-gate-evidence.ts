/**
 * TP-4404: the evidence an owner-at-head merge gate's tap reads back, from the factory's `gate.ownerEvidence`. The owner
 * reads it on the confirm sheet, and the record posts its digest, which the factory checks against a fresh read at the tap.
 */
import type { OwnerEvidence, ShepherdSource } from "./shepherd.js";

/** An owner-at-head gate's evidence as the factory read it at the gate's head. */
export type GateEvidence = Omit<Extract<OwnerEvidence, { status: "ready" }>, "status" | "gateId" | "head">;

const short = (sha: string): string => sha.slice(0, 7);

/**
 * Undefined for a gate that names no owner-at-head fact, or when the read fails: then the plain read-back stands, and the
 * factory refuses a digestless tap on such a gate. A string is why the card cannot show the evidence and the tap is withheld.
 */
export async function gateEvidenceOf(shepherd: ShepherdSource, gateId: string, headSha: string): Promise<GateEvidence | string | undefined> {
  const evidence = await shepherd.ownerEvidence(gateId).catch(() => undefined);
  if (evidence === undefined || evidence.status === "none") return undefined;
  if (evidence.status === "missing") return `the owner reads ${evidence.facts.join(", ")} at their own head, and ${evidence.reason}; run ${evidence.command}`;
  if (evidence.head !== headSha) return `the evidence was read at ${short(evidence.head)}, not at ${short(headSha)}; read the item again`;
  const { facts, mergeBase, sections, digest } = evidence;
  return { facts, mergeBase, sections, digest };
}
