import { z } from "zod";
import { WorkflowNotOwnedError, type WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost } from "../host.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./commands.js";
import { failureOf } from "./error-class.js";
import { openOrRead } from "./snapshot-reads.js";
import { POST_MERGE_STEPS } from "./post-merge.js";

/** How often `titan-factory serve` checks the PRs of runs waiting on a gate. */
export const GONE_SWEEP_MS = 5 * 60_000;

export const LANDED_ELSEWHERE = "landed elsewhere: ";
export const CLOSED_ELSEWHERE = "closed elsewhere: ";
export const DELETED_ELSEWHERE = "deleted elsewhere: ";

/** `gated` walks runs waiting on a pending gate, as the periodic sweep does; `live` walks every running or paused run. */
type GoneScope = "gated" | "live";

export interface EndedRun {
  runId: string;
  reason: string;
}

interface GoneOptions {
  scope?: GoneScope;
  /** Reports the runs it would end and cancels nothing. */
  dryRun?: boolean;
  /** Limits the walk to these runs. */
  only?: ReadonlySet<string>;
  /** Called for a run whose PR left Shepherd but whose lease a live holder still keeps, so it could not be cancelled. */
  onHeld?: (runId: string) => void;
  /** Called for a run whose PR could not be read; the run is left alone and the caller decides what that means for it. */
  onUnreadable?: (runId: string, cause: string) => void;
  /** Called for a run the runtime refused to cancel for any reason but a lease held elsewhere; the run stays live. Absent, the error is thrown. */
  onCancelFailed?: (runId: string, cause: string) => void;
}

const OWN_MERGE_STEPS: ReadonlySet<string> = new Set(["merge", "sh-landed", ...POST_MERGE_STEPS.map((declared) => declared.id)]);
const stepName = (key: string): string => key.split(":")[0]!;
export const LIVE: ReadonlySet<string> = new Set(["running", "paused"]);

/** A run that merged its PR itself, recorded it landed, or started what follows a merge reads merged on GitHub and is still Shepherd's. */
export function mergedByShepherd(run: WorkflowRun): boolean {
  return [...Object.keys(run.stepResults), ...Object.keys(run.activeSteps)].some((key) => OWN_MERGE_STEPS.has(stepName(key)));
}

/**
 * A run that merged the PR itself: a merge step in flight or one that recorded `done`. The landing record and the
 * post-merge steps alone do not say so, because a run that saw its PR merged elsewhere records them too; a waiting
 * gate of such a run is stale, where the gate of a run that merged for itself is the owner's signal about main.
 */
export function mergedItself(run: Pick<WorkflowRun, "stepResults" | "activeSteps">): boolean {
  const attempted = Object.keys(run.activeSteps).some((key) => stepName(key) === "merge");
  const landed = Object.entries(run.stepResults).some(([key, result]) => stepName(key) === "merge" && MergeLanded.safeParse(result.data?.result).success);
  return attempted || landed;
}

const MergeLanded = z.looseObject({ done: z.literal(true) });

class UnreadablePr extends Error {}

/** `GhError` and the fake's `FakeHttpError` both carry the HTTP status; a 404 on the PR means it or its repo is gone. */
const isNotFound = (error: unknown): boolean => (error as { status?: unknown } | null)?.status === 404;

/** Why the run's PR is no longer Shepherd's to land, or undefined while it is open. Rejects with `UnreadablePr` when GitHub cannot be read. */
async function goneReason(services: ShepherdServices, runId: string): Promise<string | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const target = `${registration.repo}#${registration.pr}`;
  let notFound = false;
  const pr = await openOrRead(services.port, services.snapshot, registration.repo, registration.pr).catch((error: unknown) => {
    if (!isNotFound(error)) throw new UnreadablePr(failureOf(error));
    notFound = true;
    return undefined;
  });
  if (notFound) return `${DELETED_ELSEWHERE}${target} answered 404, so the PR or its repo is gone`;
  if (!pr || pr.state === "open") return undefined;
  return pr.merged ? `${LANDED_ELSEWHERE}${target} was merged outside Shepherd` : `${CLOSED_ELSEWHERE}${target} was closed outside Shepherd`;
}

/**
 * Live and not Shepherd's own merge; read again after every await, since the run moves on while GitHub answers.
 * A run parked on a gate is not walking toward `sh-landed`, so the sweep over gated runs counts only a merge the run did.
 */
function endable(run: WorkflowRun | undefined, scope: GoneScope): run is WorkflowRun {
  if (run === undefined || !LIVE.has(run.status)) return false;
  return !(scope === "gated" ? mergedItself(run) : mergedByShepherd(run));
}

/** The questions a merged PR leaves about main: the freeze is repo-scoped and these gates hold the owner's only release, so a merged PR never answers them. */
const MAIN_GATES: ReadonlySet<string> = new Set(POST_MERGE_STEPS.filter((declared) => declared.kind === "assisted").map((declared) => declared.id));
const gateStep = (gateId: string): string => stepName(gateId.slice(gateId.lastIndexOf("/") + 1));

/** A run already `cancelling` is on its way out, so neither scope picks it up again. */
function candidateRuns(host: FactoryHost, scope: GoneScope): WorkflowRun[] {
  const runs = scope === "live" ? host.runtime.list(["running", "paused"]) : gatedRuns(host);
  return runs.filter((run) => run.workflowName === SHEPHERD_WORKFLOW && endable(run, scope));
}

/** Runs with a pending gate, less those waiting on a main gate. */
function gatedRuns(host: FactoryHost): WorkflowRun[] {
  const pending = host.pendingGates();
  const onMain = new Set(pending.filter(({ gate }) => MAIN_GATES.has(gateStep(gate.id))).map((gated) => gated.runId));
  return [...new Set(pending.map((gated) => gated.runId))].filter((runId) => !onMain.has(runId)).flatMap((runId) => host.runtime.status(runId) ?? []);
}

type CancelOutcome = "cancelled" | "held" | "failed";

/** A run another live runtime still leases cannot be cancelled from here and stays for the next sweep; any other refusal is reported. */
function tryCancel(host: FactoryHost, runId: string, reason: string, options: GoneOptions): CancelOutcome {
  try {
    host.runtime.cancel(runId, reason);
    return "cancelled";
  } catch (error) {
    if (error instanceof WorkflowNotOwnedError) return "held";
    if (!options.onCancelFailed) throw error;
    options.onCancelFailed(runId, failureOf(error));
    return "failed";
  }
}

/**
 * Ends every shepherd-pr run in scope whose PR was merged or closed elsewhere; cancelling a run cancels its pending gates.
 * The run is read again after the PR read and cancelled in that same tick, so a merge it recorded meanwhile keeps it.
 */
export async function endRunsGoneElsewhere(host: FactoryHost, services: ShepherdServices, options: GoneOptions = {}): Promise<EndedRun[]> {
  const ended: EndedRun[] = [];
  const scope = options.scope ?? "gated";
  for (const { id: runId } of candidateRuns(host, scope)) {
    if (options.only && !options.only.has(runId)) continue;
    let reason: string | undefined;
    try {
      reason = await goneReason(services, runId);
    } catch (error) {
      if (!(error instanceof UnreadablePr)) throw error;
      options.onUnreadable?.(runId, error.message);
      continue;
    }
    if (reason === undefined || !endable(host.runtime.status(runId), scope)) continue;
    const outcome = options.dryRun ? "cancelled" : tryCancel(host, runId, reason, options);
    if (outcome === "cancelled") ended.push({ runId, reason });
    else if (outcome === "held") options.onHeld?.(runId);
  }
  return ended;
}
