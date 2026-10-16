import { WorkflowNotOwnedError, type WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost } from "../host.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";
import { runOutcome } from "./run-end.js";

/**
 * Stops a new register can clear: a pushed fix may let a new head merge, and an owner abandon
 * ends the run, not the pull request, so registering it again is the owner asking for a new run.
 */
const RESTARTABLE_STOPS: ReadonlySet<string> = new Set(["not-mergeable", "conflict", "abandoned"]);

const REPLAY_DIVERGED = "replay-diverged";

interface Restart {
  /** Why the replaced run stopped; absent when it failed. */
  previousStop?: string;
}

/** A run the runtime's strict replay parked because its definition changed under it; any other park needs a human. */
export function isReplayDiverged(run: WorkflowRun): boolean {
  return run.status === "recovery_required" && run.error?.startsWith("replay diverged:") === true;
}

/** A branch-only registration has no number to read; its run waits for the PR anyway, so it restarts. */
async function openPrRestart(services: ShepherdServices, known: Registration, restart: Restart): Promise<Restart | undefined> {
  if (known.pr === null) return restart;
  const pr = await services.port.getPr(known.repo, known.pr);
  return pr.state === "open" ? restart : undefined;
}

/** A completed run that stopped on a restartable reason, with its pull request still open; any other completed run stays. */
async function restartableStop(services: ShepherdServices, known: Registration, run: WorkflowRun): Promise<Restart | undefined> {
  const reason = runOutcome(Object.values(run.stepResults))?.reason;
  if (!reason || !RESTARTABLE_STOPS.has(reason) || known.pr === null) return undefined;
  return openPrRestart(services, known, { previousStop: reason });
}

/** A failed run is dead and nothing retries it; neither does a run that stopped where a fix may help. Undefined keeps the run. */
export async function restartFor(host: FactoryHost, services: ShepherdServices, known: Registration): Promise<Restart | undefined> {
  const run = host.runtime.status(known.runId);
  if (run?.status === "failed") return {};
  if (run && isReplayDiverged(run)) return openPrRestart(services, known, { previousStop: REPLAY_DIVERGED });
  return run?.status === "completed" ? restartableStop(services, known, run) : undefined;
}

/** The registration already moved to the new run, so a run leased elsewhere is left for its owner and never seen again. */
export function endSuperseded(host: FactoryHost, runId: string, newRunId: string): void {
  try {
    host.runtime.cancel(runId, `superseded: replay diverged; restarted as ${newRunId}`);
  } catch (error) {
    if (!(error instanceof WorkflowNotOwnedError)) throw error;
  }
}
