import { DEFAULT_TABLE, evaluate, type ActionClass, type Decision, type PolicyTable } from "@titan-design/authority";
import type { OwnerOp, OwnerOpKind } from "@titan-design/owner-queue";

/**
 * The authority action each op is, as data. Until the table gains `pr-close`, `fleet-config` and `deploy-resume` (TP-3939 S0),
 * those ops sit under the nearest existing class, each of which denies owner-remote, so the console can never run them early.
 */
const OP_ACTIONS: Readonly<Record<OwnerOpKind, ActionClass>> = Object.freeze({
  "resolve-gate": "merge",
  "release-hold": "human-verb",
  "merge-at-head": "merge",
  "close-pr": "destructive-remote",
  "factory-config-set": "authority-config",
  "deploy-pause-clear": "release",
  "retire-agent": "destructive-local",
});

/** The console's tap as the table sees it: always owner-remote, never tainted, whatever the depositing agent was. */
export function opAuthority(op: OwnerOp, table: PolicyTable = DEFAULT_TABLE): Decision {
  return evaluate(table, { action: OP_ACTIONS[op.kind], actor: { class: "owner-remote", id: "titan-console" }, tainted: false, subject: { op: op.kind } });
}
