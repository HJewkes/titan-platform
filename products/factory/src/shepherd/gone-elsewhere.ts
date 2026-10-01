import type { FactoryHost } from "../host.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./commands.js";

/** How often `titan-factory serve` checks the PRs of runs waiting on a gate. */
export const GONE_SWEEP_MS = 5 * 60_000;

export interface EndedRun {
  runId: string;
  reason: string;
}

/** Why the run's PR is no longer Shepherd's to land, or undefined while it is open or cannot be read. */
async function goneReason(services: ShepherdServices, runId: string): Promise<string | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const pr = await services.port.getPr(registration.repo, registration.pr).catch(() => undefined);
  if (!pr || pr.state === "open") return undefined;
  return `${registration.repo}#${registration.pr} was ${pr.merged ? "merged" : "closed"} outside Shepherd`;
}

/** Ends every shepherd-pr run waiting on a gate whose PR was merged or closed elsewhere; cancelling a run cancels its pending gates. */
export async function endRunsGoneElsewhere(host: FactoryHost, services: ShepherdServices): Promise<EndedRun[]> {
  const gated = new Set(host.pendingGates().map((pending) => pending.runId));
  const ended: EndedRun[] = [];
  for (const runId of gated) {
    if (host.runtime.status(runId)?.workflowName !== SHEPHERD_WORKFLOW) continue;
    const reason = await goneReason(services, runId);
    if (reason === undefined) continue;
    host.runtime.cancel(runId, reason);
    ended.push({ runId, reason });
  }
  return ended;
}
