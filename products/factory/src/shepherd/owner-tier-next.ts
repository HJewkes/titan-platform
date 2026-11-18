import type { GateDecision } from "../gate-policy.js";
import { oldPathGate } from "../old-path/freeze-gate.js";
import { attestGate } from "./attest-read.js";
import { ciPolicyGate } from "./ci-policy-guard.js";
import type { DecidableEvidence } from "./merge-facts.js";
import type { PlanHonour } from "./plan-approval-cover.js";

interface LaterRow {
  row: string;
  reason: string;
}

function laterRows(evidence: DecidableEvidence, honour: PlanHonour, headSha: string): LaterRow[] {
  const policy = ciPolicyGate(evidence, honour, headSha);
  const checks = evidence.requiredChecksUnknown;
  const rows = [
    policy && { row: policy.rule.rowId, reason: policy.reason },
    attestGate(evidence.attest),
    oldPathGate(evidence.oldPath),
    checks === undefined ? undefined : { row: "required-checks-unknown", reason: checks },
  ];
  return rows.filter((row): row is LaterRow => row !== undefined);
}

/**
 * An owner-tier gate also names every later row that would gate (TP-5741), so the owner approves once with the whole
 * picture instead of approving and then meeting the next gate. Which gate wins is unchanged; only the reason grows.
 */
export function withLaterGates(gate: GateDecision, evidence: DecidableEvidence, honour: PlanHonour, headSha: string): GateDecision {
  if (gate.rule.table !== "shepherd-merge-guard" || gate.rule.rowId !== "owner-tier") return gate;
  const later = laterRows(evidence, honour, headSha).map(({ row, reason }) => `; then ${row}: ${reason}`);
  return { ...gate, reason: `${gate.reason}${later.join("")}` };
}
