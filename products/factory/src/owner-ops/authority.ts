import { DEFAULT_TABLE, evaluate, type ActionClass, type Decision, type PolicyTable } from "@titan-design/authority";
import type { OwnerOp, OwnerOpKind } from "@titan-design/owner-queue";

/** The authority action each op is, as data. */
const OP_ACTIONS: Readonly<Record<OwnerOpKind, ActionClass>> = Object.freeze({
  "resolve-gate": "merge",
  "release-hold": "human-verb",
  "merge-at-head": "merge",
  "close-pr": "pr-close",
  "factory-config-set": "fleet-config",
  "deploy-pause-clear": "deploy-resume",
  "retire-agent": "agent-retire",
});

/** The console's tap as the table sees it: always owner-remote, never tainted, whatever the depositing agent was. */
export function opAuthority(op: OwnerOp, table: PolicyTable = DEFAULT_TABLE): Decision {
  return evaluate(table, { action: OP_ACTIONS[op.kind], actor: { class: "owner-remote", id: "titan-console" }, tainted: false, subject: { op: op.kind } });
}
