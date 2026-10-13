import { OWNER_GATE_REASONS, SHEPHERD_POLICY_TABLE } from "./shepherd/policy.js";
import type { Escalation } from "./shepherd/route-table.js";

type OwnerGateReason = (typeof OWNER_GATE_REASONS)[number];

/** A row of the decision-routing table; the owner card and the weekly meter group decisions by it. */
type DClass = `D${number}`;

/** What a gate says about itself: the policy row its prompt names, if any, and its step. */
interface DecisionSubject {
  table?: string;
  rowId?: string;
  step: string;
  prompt: string;
}

const OWNER_GATE_CLASS: Record<OwnerGateReason, DClass> = {
  "gate-2-visual": "D2",
  "owner-asked": "D19",
  "g10-security": "D1",
  "proof-fixture": "D1",
};

const MERGE_GUARD_CLASS: Record<string, DClass> = {
  "visual-path": "D2",
  "files-unread": "D2",
  "github-path": "D6",
  "skill-path": "D21",
  "ci-policy-weakened": "D21",
  "ci-policy-malformed": "D21",
  "merge-state-unsettled": "D5",
  "no-facts": "D5",
  "head-mismatch": "D5",
  "required-checks-unknown": "D5",
};

const ROUTE_CLASS: Partial<Record<string, DClass>> = {
  "failed-rounds": "D7",
  "fix-first-runaway": "D8",
  "no-progress": "D8",
  conflict: "D9",
  "repair-budget": "D10",
} satisfies Partial<Record<Escalation, DClass>>;

const STEP_CLASS: Record<string, DClass> = {
  "main-red": "D13",
  "main-frozen": "D14",
  "main-red-again": "D14",
  "stuck-behind": "D15",
  "ci-failed": "D16",
  "sh-sent-back": "D16",
};

/** The seat policy's prompt names its owner-gate reason in parentheses; a gate with none is the plain owner gate, D1. */
function seatPolicyClass(prompt: string): DClass {
  const reason = OWNER_GATE_REASONS.find((candidate) => prompt.includes(`(${candidate})`));
  return reason ? OWNER_GATE_CLASS[reason] : "D1";
}

function tableClass(table: string, rowId: string, prompt: string): DClass | undefined {
  if (table === SHEPHERD_POLICY_TABLE) return seatPolicyClass(prompt);
  if (table === "shepherd-merge-guard") return MERGE_GUARD_CLASS[rowId];
  if (table === "authority") return "D4";
  if (table === "shepherd-release") return "D11";
  if (table !== "shepherd-route") return undefined;
  return rowId === "policy-denial" ? seatPolicyClass(prompt) : ROUTE_CLASS[rowId];
}

/** The D-row a gate belongs to: by the policy row that opened it, else by its step; undefined when neither is known. */
export function decisionClassOf({ table, rowId, step, prompt }: DecisionSubject): DClass | undefined {
  const byTable = table !== undefined && rowId !== undefined ? tableClass(table, rowId, prompt) : undefined;
  return byTable ?? STEP_CLASS[step];
}

const POLICY_LINE = /Policy ([a-z-]+)\/(\S+?):/;

/** The `Policy <table>/<row>:` a Shepherd or land gate's prompt carries, which is where its routing row is recorded. */
export function policyRowOf(prompt: string): { table: string; rowId: string } | undefined {
  const match = POLICY_LINE.exec(prompt);
  return match ? { table: match[1]!, rowId: match[2]! } : undefined;
}
