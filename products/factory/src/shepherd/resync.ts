import type { FactoryHost } from "../host.js";
import type { ShepherdServices } from "./commands.js";
import { LIVE, endRunsGoneElsewhere, type EndedRun } from "./gone-elsewhere.js";
import { supersedeMovedGates, type SupersededGate } from "./head-moved.js";

export const ORPHANED = "orphaned: the run already ended";

export interface ResyncReport {
  dryRun: boolean;
  /** Live shepherd-pr runs whose PR was merged or closed outside Shepherd. */
  ended: EndedRun[];
  /** Runs whose PR left Shepherd but whose lease a live holder still kept, or whose PR could not be read; `recheckHeld` settles them before adoption. */
  held: string[];
  /** Pending gates whose run already completed, failed or was cancelled. */
  orphanGates: string[];
  superseded: SupersededGate[];
  /** Why superseding moved gates failed; the rest of the report still stands. */
  supersedeError?: string;
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
  const held: string[] = [];
  const ended = await endRunsGoneElsewhere(host, services, { scope: "live", dryRun, onHeld: (runId) => held.push(runId), onUnreadable: (runId) => held.push(runId) });
  const orphans = orphanGates(host);
  if (!dryRun) for (const gateId of orphans) host.gates.cancel(gateId, ORPHANED);
  const report: ResyncReport = { dryRun, ended, held, orphanGates: orphans, superseded: [] };
  try {
    report.superseded = await supersedeMovedGates(host, services, { dryRun });
  } catch (err) {
    report.supersedeError = err instanceof Error ? err.message : String(err);
  }
  return report;
}

interface HeldRecheck {
  ended: EndedRun[];
  /** Held runs whose PR could not be read, with the read's error; adoption must leave them unclaimed this tick. */
  unreadable: Map<string, string>;
}

/**
 * Runs right before adoption for the runs resync could not cancel: adoption would drive a run whose PR left Shepherd
 * toward sh-landed, so it is ended first. `held` keeps the runs still leased elsewhere, to be rechecked on the next tick;
 * a run whose PR cannot be read is neither ended nor safe to adopt, so it is reported `unreadable` and stays held.
 */
export async function recheckHeld(host: FactoryHost, services: ShepherdServices, held: Set<string>): Promise<HeldRecheck> {
  for (const runId of held) if (!LIVE.has(host.runtime.status(runId)?.status ?? "")) held.delete(runId);
  const unreadable = new Map<string, string>();
  if (held.size === 0) return { ended: [], unreadable };
  const ended = await endRunsGoneElsewhere(host, services, { scope: "live", only: held, onUnreadable: (runId, cause) => unreadable.set(runId, cause) });
  for (const { runId } of ended) held.delete(runId);
  return { ended, unreadable };
}
