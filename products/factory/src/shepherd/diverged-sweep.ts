import type { Logger } from "@titan-design/daemon";
import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { stepOf } from "../coordinator-evidence.js";
import { SHEPHERD_ACTOR } from "./events.js";
import { classifyRegistered, restartRegistered, type Registered } from "./commands.js";
import { mergeOnOwnerAnswer, type DivergedMerge } from "./diverged-merge.js";
import type { RegisterArgs } from "./register-args.js";
import { DIVERGED_PR_CLOSED, isReplayDiverged } from "./restart.js";
import type { ShepherdServices } from "./services.js";
import type { Registration, ShepherdStore } from "./store.js";
import { SEAT_STEPS } from "./waiting.js";

interface DivergedSweep {
  restarted: DivergedRestart[];
  /** Runs cancelled because their pull request is no longer open. */
  ended: Array<{ runId: string; reason: string }>;
  /** Runs whose pull request the sweep read as no longer open, whether or not their cancel went through. */
  closed: string[];
  /** Runs left parked because an owner gate is pending on them: a restart cancels the gate and the new run never asks again. */
  kept: Array<{ runId: string; gateId: string }>;
  /** Runs merged at the head the owner approved while they were parked; a restart would have spent that answer (TP-3918). */
  merged: DivergedMerge[];
  /** A run the sweep could not read or restart; it stays parked for the next sweep. */
  errors: Array<{ runId: string; cause: string }>;
}

/** The pending owner gate of `runId`, if any; seat-routed gates are re-asked by the new run, an owner's are not. */
function pendingOwnerGate(host: FactoryHost, runId: string): string | undefined {
  return host.gates.listPending().find((gate) => gate.id.startsWith(`${runId}/`) && !SEAT_STEPS.includes(stepOf(gate.id)))?.id;
}

/** Re-registers with the facts the registration already holds, so a restart changes nothing the owner set. */
function argsOf(known: Registration): RegisterArgs {
  return {
    repo: known.repo,
    pr: known.pr!,
    ...(known.branch !== null && { branch: known.branch }),
    task: known.task,
    implementer: known.implementer,
    ...(known.reviewer !== null && { reviewer: known.reviewer }),
    kind: known.kind,
    ...(known.base != null && { base: known.base }),
  };
}

/** A restarted run is no longer diverged, so no later sweep would class it; one that cannot be classed is held adversary rather than left unclassified. */
async function classifyOrHold(ctx: FactoryContext, restarted: Registered, head: string): Promise<void> {
  try {
    await classifyRegistered(ctx, restarted, head);
  } catch (error) {
    ctx.shepherd!.store.get().holdUnlessAdversary(restarted.runId, "g10-adversary: restarted run could not be classed", { actor: SHEPHERD_ACTOR });
    throw error;
  }
}

/**
 * A pending owner gate keeps the run parked: the restart would cancel it and the new run never asks again. An owner merge
 * answered while it was parked merges at the approved head instead, when that head still stands and land's checks pass.
 */
async function restartOrKeep(ctx: FactoryContext, store: ShepherdStore, known: Registration, run: WorkflowRun, head: string, sweep: DivergedSweep): Promise<void> {
  const gateId = pendingOwnerGate(ctx.host, known.runId);
  if (gateId !== undefined) {
    sweep.kept.push({ runId: known.runId, gateId });
    return;
  }
  const merged = await mergeOnOwnerAnswer(ctx.host, ctx.shepherd!.port, known, run, head);
  if (merged !== undefined) {
    sweep.merged.push(merged);
    return;
  }
  const restarted = await restartRegistered(ctx, store, known, argsOf(known), known.policy);
  if (!restarted.created) return;
  sweep.restarted.push({ runId: known.runId, newRunId: restarted.runId });
  await classifyOrHold(ctx, restarted, head);
}

/**
 * Restarts each registration whose run strict replay parked as diverged, except one holding a pending owner gate (TP-3801) or merged on the owner's answer to it (TP-3918), and cancels the run when its pull request has closed.
 * A branch-only registration is left parked: its restart is unchecked against any pull request, so only a register may widen to it.
 * Runs are walked through their registrations, so a run this sweep already replaced is never seen again.
 */
export async function restartDivergedRuns(ctx: FactoryContext, closing: () => boolean = () => false): Promise<DivergedSweep> {
  const sweep: DivergedSweep = { restarted: [], ended: [], closed: [], kept: [], merged: [], errors: [] };
  const services = ctx.shepherd;
  if (!services) return sweep;
  const store = services.store.get();
  for (const known of store.all()) {
    if (closing()) break;
    const run = ctx.host.runtime.status(known.runId);
    if (!run || !isReplayDiverged(run) || known.pr === null) continue;
    try {
      const pr = await services.port.getPr(known.repo, known.pr);
      if (pr.state !== "open") {
        sweep.closed.push(known.runId);
        const reason = DIVERGED_PR_CLOSED;
        ctx.host.runtime.cancel(known.runId, reason, { abandon: true });
        sweep.ended.push({ runId: known.runId, reason });
        continue;
      }
      await restartOrKeep(ctx, store, known, run, pr.headSha, sweep);
    } catch (error) {
      sweep.errors.push({ runId: known.runId, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  return sweep;
}

const closedAtLastSweep = new WeakMap<ShepherdServices, ReadonlySet<string>>();

/** The parked runs serve's last sweep read a closed or merged PR for; a deploy's watch does not count them against the build (TP-3220). */
export const divergedPrClosed = (services: ShepherdServices | undefined): ReadonlySet<string> => (services && closedAtLastSweep.get(services)) ?? new Set();

export interface DivergedRestart {
  runId: string;
  newRunId: string;
}

/** Bounds the record a long-lived serve keeps; a deploy's watch reads it within minutes of the restart. */
const RESTARTS_KEPT = 200;
const restartedSinceStart = new WeakMap<ShepherdServices, readonly DivergedRestart[]>();

/** The diverged runs this serve's sweeps restarted, oldest first; a deploy's watch reports them rather than counting them against the build (TP-3889). */
export const divergedRestarts = (services: ShepherdServices | undefined): readonly DivergedRestart[] => (services && restartedSinceStart.get(services)) ?? [];

function keepRestarts(services: ShepherdServices, restarted: readonly DivergedRestart[]): void {
  if (restarted.length > 0) restartedSinceStart.set(services, [...divergedRestarts(services), ...restarted].slice(-RESTARTS_KEPT));
}

/** Runs at the head of each adoption, so a deploy that changed the call sequence strands none of the runs it parked; a failure here never keeps the adopt step from running. */
export async function restartDivergedLogged(host: FactoryHost, services: ShepherdServices, log: Logger, closing: () => boolean = () => false): Promise<void> {
  try {
    const { restarted, ended, closed, kept, merged, errors } = await restartDivergedRuns({ host, shepherd: services, warnings: [], format: "json" }, closing);
    closedAtLastSweep.set(services, new Set(closed));
    keepRestarts(services, restarted);
    for (const run of restarted) log.info({ ...run }, "restarted a replay-diverged run");
    for (const run of ended) log.info({ ...run }, "ended a replay-diverged run whose PR is no longer open");
    for (const run of merged) log.info({ ...run }, "merged a replay-diverged run at the head its owner approved while it was parked");
    for (const run of kept) log.warn({ ...run }, "left a replay-diverged run parked: its owner gate is still pending");
    for (const run of errors) log.warn({ ...run }, "left a replay-diverged run parked: it could not be restarted");
  } catch (error) {
    log.warn({ cause: error instanceof Error ? error.message : String(error) }, "the replay-diverged sweep failed; adoption goes on without it");
  }
}
