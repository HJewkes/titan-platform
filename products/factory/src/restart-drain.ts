import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "./definition.js";
import { stepPhase } from "./shepherd/step-phase.js";
import { SHEPHERD_WORKFLOW } from "./shepherd/services.js";

/** `park` names a step whose route parks the run on restart; it outranks the step's Shepherd phase. */
export type BusyPhase = "review" | "merging" | "park";

/** A running run a restart would interrupt badly: mid-review, mid-merge, or in a park-routed step. */
export interface BusyRun {
  runId: string;
  step: string;
  phase: BusyPhase;
}

/** What the drain reads from the machine; tests pass a fake `/health` sequence and a fake clock. */
export interface DrainPorts {
  health: (port: number) => Promise<Record<string, unknown> | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface DrainOptions {
  port: number;
  timeoutMs: number;
  /** Restart even when a park-routed step is still busy at the deadline. */
  force: boolean;
  /** Check once instead of waiting; a busy park-routed step still refuses without `force`. */
  wait: boolean;
}

/** `atRestart` is the last `/health` answer the drain read before letting the restart go, or null when serve was silent. */
export type DrainOutcome = { proceed: true; atRestart: Record<string, unknown> | null } | { proceed: false; why: string };

export const DEFAULT_DRAIN_TIMEOUT_MS = 45 * 60_000;
const DRAIN_POLL_MS = 5_000;
const REPORT_EVERY_MS = 60_000;
/** Consecutive unanswered `/health` polls for this long mean serve is down, not slow. */
export const NO_ANSWER_PROCEED_MS = 2 * 60_000;
const DRAIN_PHASES: ReadonlySet<string> = new Set(["review", "merging"]);
const isDrainPhase = (phase: string): phase is BusyPhase => DRAIN_PHASES.has(phase);
/**
 * Waits that only poll a store a restart reads again, so a restart costs them nothing; an exhausted account or an unbound checkout can hold one for days,
 * a seat reviewer runs outside serve, so its verdict waits for the repeated read, and a merging run in sh-order-wait only polls for the PRs ahead of it, replaying that wait (TP-4567).
 */
const IDLE_WAITS: readonly string[] = ["sh-account-wait", "sh-no-reviewer-wait", "sh-await-verdict", "sh-late-verdict", "sh-seat-recheck", "sh-order-wait"];
const MERGE_STEP = "merge";
/** The review spawn step; it is repeated on restart and finds by name any reviewer an earlier run spawned, so a restart before the spawn loses nothing. */
const REVIEW_SPAWN_STEP = "sh-review";

type RouteFor = (stepId: string) => Pick<StepRoute, "onRestart"> | undefined;

/** True when the run's Shepherd hold is active and unsatisfied, so it cannot merge until released; a failed read answers false and the run stays busy. */
export type HoldPredicate = (run: WorkflowRun) => boolean;

const notHeld: HoldPredicate = () => false;

/** True when the spawn gate deferred the run's review and has not admitted it, so no reviewer was started; a failed read answers false and the run stays busy. */
export type QueuedPredicate = (run: WorkflowRun) => boolean;

/** A review step the gate keeps waiting has started nobody, so a restart costs it nothing (TP-4474). */
function gateQueued(isQueued: QueuedPredicate, run: WorkflowRun, busy: BusyRun): boolean {
  return busy.phase === "review" && stepIdMatches(REVIEW_SPAWN_STEP, busy.step) && heldNow(isQueued, run);
}

function classify(run: WorkflowRun, routeFor: RouteFor): BusyRun | undefined {
  const step = run.currentStep;
  if (run.status !== "running" || step === null) return undefined;
  if (routeFor(step)?.onRestart === "park") return { runId: run.id, step, phase: "park" };
  if (IDLE_WAITS.some((id) => stepIdMatches(id, step))) return undefined;
  const phase = stepPhase(step);
  return isDrainPhase(phase) ? { runId: run.id, step, phase } : undefined;
}

/**
 * True for a shepherd-pr run at `merge` while another run holds its repo's train: it only polls for its turn, so a restart costs it nothing.
 * A free train, or its own, means it may merge at any moment. `holderOf` names the run holding the train of the run's repo.
 */
export function behindTrain(holderOf: (run: WorkflowRun) => string | undefined): HoldPredicate {
  return (run) => {
    if (run.workflowName !== SHEPHERD_WORKFLOW || run.currentStep === null || !stepIdMatches(MERGE_STEP, run.currentStep)) return false;
    const holder = holderOf(run);
    return holder !== undefined && holder !== run.id;
  };
}

function heldNow(isHeld: HoldPredicate, run: WorkflowRun): boolean {
  try {
    return isHeld(run);
  } catch {
    return false;
  }
}

/**
 * The running runs whose current step a restart would repeat mid-review or mid-merge, or park for a human; a held run in a merge step is not one, since it cannot merge
 * until released, nor is a review spawn the gate still queues.
 */
export function busyRuns(runs: readonly WorkflowRun[], routeFor: RouteFor, isHeld: HoldPredicate = notHeld, isQueued: QueuedPredicate = notHeld): BusyRun[] {
  return runs.flatMap((run) => {
    const busy = classify(run, routeFor);
    return busy && !(busy.phase === "merging" && heldNow(isHeld, run)) && !gateQueued(isQueued, run, busy) ? [busy] : [];
  });
}

/** The held merge-step runs `busyRuns` skipped, so the drain can say so. */
export function heldSkipped(runs: readonly WorkflowRun[], routeFor: RouteFor, isHeld: HoldPredicate): BusyRun[] {
  return runs.flatMap((run) => {
    const busy = classify(run, routeFor);
    return busy?.phase === "merging" && heldNow(isHeld, run) ? [busy] : [];
  });
}

/** A build from before the busy field has nothing to drain; the drain itself treats no answer as unknown. */
export function readBusy(health: Record<string, unknown> | null): BusyRun[] {
  return Array.isArray(health?.busy) ? (health.busy as BusyRun[]) : [];
}

/** Held runs the restart does not wait for follow the busy ones. */
function readHeldSkipped(health: Record<string, unknown> | null): BusyRun[] {
  return Array.isArray(health?.heldSkipped) ? (health.heldSkipped as BusyRun[]) : [];
}

export function describeBusy(busy: readonly BusyRun[], held: readonly BusyRun[] = [], admitted: readonly BusyRun[] = []): string {
  const lines = busy.map((run) => `  ${run.runId} ${run.step} (${run.phase})\n`);
  const skipped = [...held.map((run) => `  ${run.runId} ${run.step} (held, not waited for)\n`), ...admitted.map((run) => `  ${run.runId} ${run.step} (busy since the drain began, not waited for)\n`)];
  return [...lines, ...skipped].join("");
}

/** One answered poll as the drain reads it; `health` is the raw answer, so the watch window still counts every run the restart interrupts. */
interface PollView {
  health: Record<string, unknown> | null;
  busy: BusyRun[];
  held: BusyRun[];
  admitted: BusyRun[];
}

/**
 * Serve keeps admitting review and merge steps while the drain waits, so waiting on every busy run let one deploy run 17 minutes (TP-4607); only runs busy at the
 * first answer hold the restart. A park-routed step still holds it whenever it is busy, since a restart leaves its run recovery_required.
 */
function viewOf(health: Record<string, unknown> | null, waitedOn: ReadonlySet<string>): PollView {
  const holds = (run: BusyRun): boolean => run.phase === "park" || waitedOn.has(run.runId);
  const all = readBusy(health);
  return { health, busy: all.filter(holds), held: readHeldSkipped(health), admitted: all.filter((run) => !holds(run)) };
}

/**
 * Poll `/health` until no run busy at the first answer is still busy, or the deadline passes; only a busy park-routed step refuses, and `force` overrides it.
 * A poll with no answer is unknown, not idle.
 */
export async function drainForRestart(ports: DrainPorts, report: (text: string) => void, options: DrainOptions): Promise<DrainOutcome> {
  const deadline = ports.now() + options.timeoutMs;
  const reporter = everyMinute(ports, report);
  let silentSince: number | null = null;
  let waitedOn: ReadonlySet<string> | undefined;
  for (;;) {
    const health = await ports.health(options.port);
    if (health === null && options.wait) {
      silentSince ??= ports.now();
      if (silentLongEnough(ports, silentSince, deadline, report)) return { proceed: true, atRestart: null };
      reporter("serve did not answer /health; still draining");
    } else {
      silentSince = null;
      waitedOn ??= new Set(readBusy(health).map((run) => run.runId));
      const view = viewOf(health, waitedOn);
      const outcome = answered(view, ports.now() >= deadline, options, report);
      if (outcome) return outcome;
      reporter(`waiting for ${view.busy.length} busy run(s) before restarting:\n${describeBusy(view.busy, view.held, view.admitted)}`);
    }
    await ports.sleep(DRAIN_POLL_MS);
  }
}

function everyMinute(ports: DrainPorts, report: (text: string) => void): (text: string) => void {
  let nextReport = ports.now();
  return (text) => {
    if (ports.now() < nextReport) return;
    report(text);
    nextReport = ports.now() + REPORT_EVERY_MS;
  };
}

/** A serve that stays silent is down, and the restart is its fix; a park-routed step it may hold cannot be seen either way. */
function silentLongEnough(ports: DrainPorts, silentSince: number, deadline: number, report: (text: string) => void): boolean {
  if (ports.now() - silentSince >= NO_ANSWER_PROCEED_MS) {
    report("serve has not answered /health for 2 min; restarting it");
    return true;
  }
  if (ports.now() < deadline) return false;
  report("the drain timed out with serve not answering /health; restarting it");
  return true;
}

/** The outcome for an answered poll, or for any poll when not waiting; undefined keeps draining. */
function answered(view: PollView, pastDeadline: boolean, options: DrainOptions, report: (text: string) => void): DrainOutcome | undefined {
  if (view.busy.length === 0) {
    const skipped = view.held.length + view.admitted.length;
    if (skipped > 0) report(`restarting without waiting for ${skipped} held or newly busy run(s):\n${describeBusy([], view.held, view.admitted)}`);
    return { proceed: true, atRestart: view.health };
  }
  return !options.wait || pastDeadline ? atDeadline(view, options, report) : undefined;
}

function atDeadline(view: PollView, options: DrainOptions, report: (text: string) => void): DrainOutcome {
  const parked = view.busy.filter((run) => run.phase === "park");
  const stopped = options.wait ? "the drain timed out" : "--no-drain skipped the wait";
  if (parked.length > 0 && !options.force) {
    return { proceed: false, why: `${stopped} with a park-routed step busy; a restart now leaves its run recovery_required. Wait, or rerun with --force:\n${describeBusy(parked)}` };
  }
  report(`${stopped}; restarting with ${view.busy.length} busy run(s):\n${describeBusy(view.busy, view.held, view.admitted)}`);
  return { proceed: true, atRestart: view.health };
}
