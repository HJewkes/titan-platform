import type { GateDecision } from "../gate-policy.js";
import type { SettleKind, UnsettledMerge } from "../workflows/land-settle.js";
import { MERGE_BY_REVIEWER_RULE, isUnsettledGate } from "./merge-facts.js";

/** Each wait that replaces an approve-merge gate (TP-3734 r3b, gate-context F2); false asks the owner as before. */
interface WaitDemotions {
  frozenOnly: boolean;
  noFacts: boolean;
}

export const WAIT_DEMOTIONS: WaitDemotions = { frozenOnly: true, noFacts: true };

const REVIEWER_UNMET = new RegExp(`^${MERGE_BY_REVIEWER_RULE} unmet: (.+)$`);

/** MRG-AU-RV failed on the freeze alone, so once the repo thaws it holds at this head with no new review. */
export function isFrozenOnlyGate(decision: GateDecision): boolean {
  if (decision.outcome !== "gate" || decision.rule.table !== "authority") return false;
  const unmet = decision.reason.split("; ").map((part) => REVIEWER_UNMET.exec(part)?.[1]);
  return unmet.find((conditions) => conditions !== undefined) === "repo-not-frozen";
}

/** No merge facts stood at the head; one more read may find them before the seat hears of it. */
export function isNoFactsGate(decision: GateDecision): boolean {
  return decision.outcome === "gate" && decision.rule.table === "shepherd-merge-guard" && decision.rule.rowId === "no-facts";
}

function settleKind(decision: GateDecision): SettleKind {
  if (WAIT_DEMOTIONS.frozenOnly && isFrozenOnlyGate(decision)) return "thaw";
  if (WAIT_DEMOTIONS.noFacts && isNoFactsGate(decision)) return "once";
  return "settle";
}

/** The gates land waits on at their head instead of asking the owner: unsettled mergeability, a freeze alone, and missing facts. */
export function headWaits(refresh: UnsettledMerge["refresh"]): UnsettledMerge {
  const transient = (decision: GateDecision) => isUnsettledGate(decision) || settleKind(decision) !== "settle";
  return { transient, kind: settleKind, refresh };
}
