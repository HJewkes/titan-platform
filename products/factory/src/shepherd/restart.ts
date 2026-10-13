import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost } from "../host.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";
import { runOutcome } from "./run-end.js";

/**
 * Stops a new register can clear: a pushed fix may let a new head merge, and an owner abandon
 * ends the run, not the pull request, so registering it again is the owner asking for a new run.
 */
const RESTARTABLE_STOPS: ReadonlySet<string> = new Set(["not-mergeable", "conflict", "abandoned"]);

interface Restart {
  /** Why the replaced run stopped; absent when it failed. */
  previousStop?: string;
}

/** A completed run that stopped on a restartable reason, with its pull request still open; any other completed run stays. */
async function restartableStop(services: ShepherdServices, known: Registration, run: WorkflowRun): Promise<Restart | undefined> {
  const reason = runOutcome(Object.values(run.stepResults))?.reason;
  if (!reason || !RESTARTABLE_STOPS.has(reason) || known.pr === null) return undefined;
  const pr = await services.port.getPr(known.repo, known.pr);
  return pr.state === "open" ? { previousStop: reason } : undefined;
}

/** A failed run is dead and nothing retries it; neither does a run that stopped where a fix may help. Undefined keeps the run. */
export async function restartFor(host: FactoryHost, services: ShepherdServices, known: Registration): Promise<Restart | undefined> {
  const run = host.runtime.status(known.runId);
  if (run?.status === "failed") return {};
  return run?.status === "completed" ? restartableStop(services, known, run) : undefined;
}
