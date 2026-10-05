import type { FactoryHost } from "../host.js";
import type { ShepherdServices } from "./commands.js";
import { LIVE, endRunsGoneElsewhere, type EndedRun } from "./gone-elsewhere.js";
import { supersedeMovedGates, type SupersededGate } from "./head-moved.js";
import { FINISHED_RUN_STATUSES } from "./run-status.js";

export const ORPHANED = "orphaned: the run already ended";

interface CancelError {
  runId: string;
  cause: string;
}

export interface ResyncReport {
  dryRun: boolean;
  /** Live shepherd-pr runs whose PR was merged or closed outside Shepherd. */
  ended: EndedRun[];
  /** Runs whose PR left Shepherd but whose lease a live holder still kept, or whose PR could not be read; `recheckHeld` settles them before adoption. */
  held: string[];
  /** Held runs the runtime refused to cancel for a reason other than a lease, with that reason. */
  cancelErrors: CancelError[];
  /** Pending gates whose run already completed, failed or was cancelled. */
  orphanGates: string[];
  superseded: SupersededGate[];
  /** Why superseding moved gates failed; the rest of the report still stands. */
  supersedeError?: string;
}

/** A gate id is `<runId>/<step>`; a gate whose run is gone from the store is left alone. */
function orphanGates(host: FactoryHost): string[] {
  return host.gates.listPending().flatMap((gate) => {
    const runId = gate.id.slice(0, Math.max(0, gate.id.indexOf("/")));
    const status = runId ? host.runtime.status(runId)?.status : undefined;
    return status !== undefined && FINISHED_RUN_STATUSES.has(status) ? [gate.id] : [];
  });
}

/**
 * Brings Shepherd's runs and gates in line with GitHub after time away: ends live runs whose PR left Shepherd, cancels
 * the gates of runs that already ended, then supersedes gates whose open PR moved head. A PR that cannot be read
 * leaves its run alone. `dryRun` computes the same report and writes nothing.
 */
export async function resyncShepherd(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): Promise<ResyncReport> {
  const held: string[] = [];
  const cancelErrors: CancelError[] = [];
  const onCancelFailed = (runId: string, cause: string) => {
    held.push(runId);
    cancelErrors.push({ runId, cause });
  };
  const ended = await endRunsGoneElsewhere(host, services, { scope: "live", dryRun, onHeld: (runId) => held.push(runId), onUnreadable: (runId) => held.push(runId), onCancelFailed });
  const orphans = orphanGates(host);
  if (!dryRun) for (const gateId of orphans) host.gates.cancel(gateId, ORPHANED);
  const report: ResyncReport = { dryRun, ended, held, cancelErrors, orphanGates: orphans, superseded: [] };
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
  /** Held runs whose PR left Shepherd but whose cancel failed for a reason other than a lease; adoption must leave them unclaimed too. */
  uncancelled: Map<string, string>;
}

/**
 * Runs right before adoption for the runs resync could not cancel: adoption would drive a run whose PR left Shepherd
 * toward sh-landed, so it is ended first. `held` keeps the runs still leased elsewhere, to be rechecked on the next tick;
 * a run whose PR cannot be read is neither ended nor safe to adopt, so it is reported `unreadable` and stays held, as is
 * one whose cancel failed, reported `uncancelled`.
 */
export async function recheckHeld(host: FactoryHost, services: ShepherdServices, held: Set<string>): Promise<HeldRecheck> {
  for (const runId of held) if (!LIVE.has(host.runtime.status(runId)?.status ?? "")) held.delete(runId);
  const unreadable = new Map<string, string>();
  const uncancelled = new Map<string, string>();
  if (held.size === 0) return { ended: [], unreadable, uncancelled };
  const onUnreadable = (runId: string, cause: string) => unreadable.set(runId, cause);
  const ended = await endRunsGoneElsewhere(host, services, { scope: "live", only: held, onUnreadable, onCancelFailed: (runId, cause) => uncancelled.set(runId, cause) });
  for (const { runId } of ended) held.delete(runId);
  return { ended, unreadable, uncancelled };
}
