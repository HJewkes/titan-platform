import type { OwnerOpKind } from "@titan-design/owner-queue";

/** The tap's verb for each owner-op kind the console offers; a kind missing here takes the action's own verb. */
export const OP_VERB: Partial<Record<OwnerOpKind, string>> = {
  "merge-at-head": "Merge at head",
  "retire-agent": "Retire",
  "close-pr": "Close PR",
  "deploy-pause-clear": "Clear deploy pause",
  "plan-bet-select": "Select bets",
  "plan-outcome-edit": "Edit outcome",
  "plan-freeze-set": "Set freeze",
};

/** A planning op reads the plan store, not a gate and head, so its sheet says what it is reading. */
export const isPlanOpKind = (kind: OwnerOpKind): boolean => kind.startsWith("plan-");
