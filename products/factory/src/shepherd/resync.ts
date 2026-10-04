import type { FactoryHost } from "../host.js";
import type { ShepherdServices } from "./commands.js";
import { endRunsGoneElsewhere, type EndedRun } from "./gone-elsewhere.js";
import { supersedeMovedGates, type SupersededGate } from "./head-moved.js";

export const ORPHANED = "orphaned: the run already ended";

export interface ResyncReport {
  dryRun: boolean;
  /** Live shepherd-pr runs whose PR was merged or closed outside Shepherd. */
  ended: EndedRun[];
  /** Pending gates whose run already completed, failed or was cancelled. */
  orphanGates: string[];
  superseded: SupersededGate[];
}

const ENDED_RUNS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** A gate id is `<runId>/<step>`; a gate whose run is gone from the store is left alone. */
function orphanGates(host: FactoryHost): string[] {
  return host.gates.listPending().flatMap((gate) => {
    const runId = gate.id.slice(0, Math.max(0, gate.id.indexOf("/")));
    const status = runId ? host.runtime.status(runId)?.status : undefined;
    return status !== undefined && ENDED_RUNS.has(status) ? [gate.id] : [];
  });
}

/**
 * Brings Shepherd's runs and gates in line with GitHub after time away: ends live runs whose PR left Shepherd, cancels
 * the gates of runs that already ended, then supersedes gates whose open PR moved head. A PR that cannot be read
 * leaves its run alone. `dryRun` computes the same report and writes nothing.
 */
export async function resyncShepherd(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): Promise<ResyncReport> {
  const ended = await endRunsGoneElsewhere(host, services, { scope: "live", dryRun });
  const orphans = orphanGates(host);
  if (!dryRun) for (const gateId of orphans) host.gates.cancel(gateId, ORPHANED);
  const superseded = await supersedeMovedGates(host, services, { dryRun });
  return { dryRun, ended, orphanGates: orphans, superseded };
}
