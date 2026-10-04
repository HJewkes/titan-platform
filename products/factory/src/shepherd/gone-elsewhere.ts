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

const OWN_MERGE_STEPS: ReadonlySet<string> = new Set(["merge", "sh-landed", ...POST_MERGE_STEPS.map((declared) => declared.id)]);
const stepName = (key: string): string => key.split(":")[0]!;
const LIVE: ReadonlySet<string> = new Set(["running", "paused"]);

/** A run that merged its PR itself, recorded it landed, or started what follows a merge reads merged on GitHub and is still Shepherd's. */
export function mergedByShepherd(run: WorkflowRun): boolean {
  return [...Object.keys(run.stepResults), ...Object.keys(run.activeSteps)].some((key) => OWN_MERGE_STEPS.has(stepName(key)));
}

/** Why the run's PR is no longer Shepherd's to land, or undefined while it is open or cannot be read. */
async function goneReason(services: ShepherdServices, runId: string): Promise<string | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const pr = await services.port.getPr(registration.repo, registration.pr).catch(() => undefined);
  if (!pr || pr.state === "open") return undefined;
  const target = `${registration.repo}#${registration.pr}`;
  return pr.merged ? `${LANDED_ELSEWHERE}${target} was merged outside Shepherd` : `${CLOSED_ELSEWHERE}${target} was closed outside Shepherd`;
}

/** Live and not Shepherd's own merge; read again after every await, since the run moves on while GitHub answers. */
function endable(run: WorkflowRun | undefined): run is WorkflowRun {
  return run !== undefined && LIVE.has(run.status) && !mergedByShepherd(run);
}

/** A run already `cancelling` is on its way out, so neither scope picks it up again. */
function candidateRuns(host: FactoryHost, scope: GoneScope): WorkflowRun[] {
  const runs =
    scope === "live"
      ? host.runtime.list(["running", "paused"])
      : [...new Set(host.pendingGates().map((pending) => pending.runId))].flatMap((runId) => host.runtime.status(runId) ?? []);
  return runs.filter((run) => run.workflowName === SHEPHERD_WORKFLOW && endable(run));
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

/**
 * Ends every shepherd-pr run in scope whose PR was merged or closed elsewhere; cancelling a run cancels its pending gates.
 * The run is read again after the PR read and cancelled in that same tick, so a merge it recorded meanwhile keeps it.
 */
export async function endRunsGoneElsewhere(host: FactoryHost, services: ShepherdServices, options: GoneOptions = {}): Promise<EndedRun[]> {
  const ended: EndedRun[] = [];
  for (const { id: runId } of candidateRuns(host, options.scope ?? "gated")) {
    const reason = await goneReason(services, runId);
    if (reason === undefined || !endable(host.runtime.status(runId))) continue;
    if (options.dryRun || tryCancel(host, runId, reason)) ended.push({ runId, reason });
  }
  return ended;
}
