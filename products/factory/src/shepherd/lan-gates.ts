import { EXIT } from "@titan-design/registry";
import { GATE_NAME, type GateEvidence } from "./gate-evidence.js";

export { gateEvidenceMigration } from "./gate-evidence.js";

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
export function lanGatesClearAt(evidence: GateEvidence, repo: string, hold: { reason: string; reviewer: string | null }, head: string): boolean {
  const gates = gatesOf(hold.reason);
  if (!gates || gates.length === 0 || hold.reviewer !== null) return false;
  return gates.every((gate) => evidence.conclusionAt(repo, head, gate) === "success");
}
