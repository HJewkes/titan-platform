import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost } from "../host.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./commands.js";
import { POST_MERGE_STEPS } from "./post-merge.js";

/** How often `titan-factory serve` checks the PRs of runs waiting on a gate. */
export const GONE_SWEEP_MS = 5 * 60_000;

export const LANDED_ELSEWHERE = "landed elsewhere: ";
export const CLOSED_ELSEWHERE = "closed elsewhere: ";

/** `gated` walks runs waiting on a pending gate, as the periodic sweep does; `live` walks every running or paused run. */
export type GoneScope = "gated" | "live";

export interface EndedRun {
  runId: string;
  reason: string;
}

export interface GoneOptions {
  scope?: GoneScope;
  /** Reports the runs it would end and cancels nothing. */
  dryRun?: boolean;
}

const OWN_MERGE_STEPS: ReadonlySet<string> = new Set(["merge", ...POST_MERGE_STEPS.map((declared) => declared.id)]);
const stepName = (key: string): string => key.split(":")[0]!;

/** A run that merged its PR itself, or has started what follows a merge, reads merged on GitHub and is still Shepherd's. */
export function mergedByShepherd(run: WorkflowRun): boolean {
  return [...Object.keys(run.stepResults), ...Object.keys(run.activeSteps)].some((key) => OWN_MERGE_STEPS.has(stepName(key)));
}

/** Why the run's PR is no longer Shepherd's to land, or undefined while it is open, cannot be read, or Shepherd merged it. */
async function goneReason(services: ShepherdServices, run: WorkflowRun): Promise<string | undefined> {
  if (mergedByShepherd(run)) return undefined;
  const registration = services.store.get().byRun(run.id);
  if (!registration || registration.pr === null) return undefined;
  const pr = await services.port.getPr(registration.repo, registration.pr).catch(() => undefined);
  if (!pr || pr.state === "open") return undefined;
  const target = `${registration.repo}#${registration.pr}`;
  return pr.merged ? `${LANDED_ELSEWHERE}${target} was merged outside Shepherd` : `${CLOSED_ELSEWHERE}${target} was closed outside Shepherd`;
}

/** A run already `cancelling` is on its way out, so neither scope picks it up again. */
function candidateRuns(host: FactoryHost, scope: GoneScope): WorkflowRun[] {
  const runs =
    scope === "live"
      ? host.runtime.list(["running", "paused"])
      : [...new Set(host.pendingGates().map((pending) => pending.runId))].flatMap((runId) => host.runtime.status(runId) ?? []);
  return runs.filter((run) => run.workflowName === SHEPHERD_WORKFLOW && (run.status === "running" || run.status === "paused"));
}

/** A run another live runtime still leases cannot be cancelled from here; it stays for the next sweep. */
function tryCancel(host: FactoryHost, runId: string, reason: string): boolean {
  try {
    host.runtime.cancel(runId, reason);
    return true;
  } catch {
    return false;
  }
}

/** Ends every shepherd-pr run in scope whose PR was merged or closed elsewhere; cancelling a run cancels its pending gates. */
export async function endRunsGoneElsewhere(host: FactoryHost, services: ShepherdServices, options: GoneOptions = {}): Promise<EndedRun[]> {
  const ended: EndedRun[] = [];
  for (const run of candidateRuns(host, options.scope ?? "gated")) {
    const reason = await goneReason(services, run);
    if (reason === undefined) continue;
    if (options.dryRun || tryCancel(host, run.id, reason)) ended.push({ runId: run.id, reason });
  }
  return ended;
}
