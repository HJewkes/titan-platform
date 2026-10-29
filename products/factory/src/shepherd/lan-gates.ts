import { EXIT } from "@titan-design/registry";
import { GATE_NAME, type GateEvidence } from "./gate-evidence.js";
import type { Registration } from "./store.js";

export type { GateEvidence } from "./gate-evidence.js";

export { gateEvidenceMigration, gateEvidenceTable } from "./gate-evidence.js";

/**
 * Gates that cannot run in GitHub Actions, such as a check against a device on the local network. The reason names them,
 * `lan-gates: <gate>, <gate>; <detail>`, and the hold stands aside at any head where each has a green record.
 */
export const LAN_GATES_CLASS = "lan-gates";
const PREFIX = `${LAN_GATES_CLASS}:`;

/** The gates a `lan-gates` reason names, between its class and the first ";"; undefined for a reason of any other class. */
function gatesOf(reason: string): string[] | undefined {
  if (!reason.startsWith(PREFIX)) return undefined;
  const list = reason.slice(PREFIX.length).split(";")[0] ?? "";
  return [...new Set(list.split(",").map((gate) => gate.trim()))].filter((gate) => gate !== "");
}

/** Syntax only, so `checkHoldReason` stays pure; whether each gate is declared is `refuseUnknownGates`'s to read. */
export function gateListRefusal(reason: string): string | undefined {
  const gates = gatesOf(reason) ?? [];
  const bad = gates.filter((gate) => !GATE_NAME.test(gate));
  if (gates.length > 0 && bad.length === 0) return undefined;
  return `hold refused, nothing was held: a ${LAN_GATES_CLASS} hold names its gates as "${PREFIX} <gate>, <gate>; <detail>", and ${bad.length > 0 ? `"${bad.join('", "')}" is not a gate name` : "it names none"}`;
}

/** A hold naming a gate no evidence can ever be recorded for would never release itself, so it is refused before anything is held. */
export function refuseUnknownGates(evidence: GateEvidence, reason: string): void {
  const unknown = (gatesOf(reason) ?? []).filter((gate) => !evidence.known(gate));
  if (unknown.length === 0) return;
  const message = `hold refused, nothing was held: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a declared gate" : "are not declared gates"}, so no evidence could release it`;
  throw Object.assign(new Error(message), { code: EXIT.DATAERR });
}

/**
 * Whether a `lan-gates` hold stands aside at `head`: every gate it names has a green newest record at exactly that head. The hold
 * itself is never lifted, so a push to a new head, or a merge read at no head, finds it held again until that head's gates are green.
 * A hold naming a reviewer waits for that reviewer, as a g10-review one does.
 */
function lanGatesClearAt(evidence: GateEvidence, repo: string, hold: { holdReason: string | null; holdReviewer: string | null }, head: string): boolean {
  const gates = hold.holdReason === null ? undefined : gatesOf(hold.holdReason);
  if (!gates || gates.length === 0 || hold.holdReviewer !== null) return false;
  return gates.every((gate) => evidence.conclusionAt(repo, head, gate) === "success");
}

/** The hold facts of one registration, and the evidence its lan-gates read; the store and its readers' fakes both supply them. */
export type HoldFacts = Pick<Registration, "repo" | "held" | "holdReason" | "holdReviewer" | "holdSatisfied" | "ownerHold">;
export interface GateEvidenceSource {
  gateEvidence(): GateEvidence;
}

/** The one test of whether a run's gating hold lets it merge at `head`: its reviewer's MERGE, or green lan-gates, at exactly that head. None passes an owner hold. */
export function holdPassedAt(source: GateEvidenceSource, registration: HoldFacts, head: string): boolean {
  if (registration.ownerHold !== null) return false;
  return registration.holdSatisfied?.head === head || lanGatesClearAt(source.gateEvidence(), registration.repo, registration, head);
}

/**
 * Whether a hold keeps the run from merging, as merge order and the restart drain read it at the head the run's merge step is at.
 * A MERGE at any head still lets the run merge once its head comes round, as before; green lan-gates count only at `head`.
 */
export function holdBarsMerge(source: GateEvidenceSource, registration: HoldFacts | undefined, head: string | undefined): boolean {
  if (registration?.held !== true) return false;
  if (registration.ownerHold === null && registration.holdSatisfied !== null) return false;
  return head === undefined || !holdPassedAt(source, registration, head);
}
