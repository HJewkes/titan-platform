import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost } from "../host.js";
import type { ShepherdServices } from "./commands.js";
import type { Registration } from "./store.js";
import { runOutcome } from "./view.js";

/** Stops a pushed fix can clear: the run handed the PR to an agent that never took it, so a new head may merge. */
const RESTARTABLE_STOPS: ReadonlySet<string> = new Set(["not-mergeable", "conflict"]);

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
