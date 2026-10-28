import type { FactoryHost } from "../host.js";
import { LIVE } from "../shepherd/gone-elsewhere.js";
import type { ShepherdStore } from "../shepherd/store.js";
import { consoleResolver, type Outcome } from "./outcome.js";
import type { PlanApprovalAction, Read } from "./record.js";

/**
 * Records the owner's plan-time answer as the console's owner-remote, the waive-proof tap's binding: the record names what
 * was approved, never who approved it. One confirmation writes one row, so a repeat post reads back `already`. The row is
 * claimed by the task's live run only when exactly one exists in the repo; with none the next registration claims it, and
 * with several no run does, since the owner's answer cannot say which PR it meant.
 */
export function recordPlanApproval({ action, confirmEvent }: Read<PlanApprovalAction>, store: ShepherdStore, host: FactoryHost): Outcome {
  const live = store.all().filter((registration) => registration.repo === action.repo.toLowerCase() && registration.task === action.task && LIVE.has(host.runtime.status(registration.runId)?.status ?? ""));
  const claimedRun = live.length === 1 ? live[0]!.runId : null;
  const wrote = store.planApprovals().record(action, consoleResolver(confirmEvent), claimedRun ?? undefined);
  return wrote ? { outcome: "plan-approved", task: action.task, gate: action.gate, claimedRun } : { outcome: "already", task: action.task };
}
