import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "./definition.js";
import { stepPhase } from "./shepherd/step-phase.js";

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

export type DrainOutcome = { proceed: true } | { proceed: false; why: string };

export const DEFAULT_DRAIN_TIMEOUT_MS = 45 * 60_000;
const DRAIN_POLL_MS = 5_000;
const REPORT_EVERY_MS = 60_000;
/** Consecutive unanswered `/health` polls for this long mean serve is down, not slow. */
export const NO_ANSWER_PROCEED_MS = 2 * 60_000;
const DRAIN_PHASES: ReadonlySet<string> = new Set(["review", "merging"]);
/** Waits that only poll a store a restart reads again, so a restart costs them nothing; an exhausted account or an unbound checkout can hold one for days. */
const IDLE_WAITS: readonly string[] = ["sh-account-wait", "sh-no-reviewer-wait"];

type RouteFor = (stepId: string) => Pick<StepRoute, "onRestart"> | undefined;

/** True when the run's Shepherd hold is active and unsatisfied, so it cannot merge until released; a failed read answers false and the run stays busy. */
export type HoldPredicate = (run: WorkflowRun) => boolean;

const notHeld: HoldPredicate = () => false;

function classify(run: WorkflowRun, routeFor: RouteFor): BusyRun | undefined {
  const step = run.currentStep;
  if (run.status !== "running" || step === null) return undefined;
  if (routeFor(step)?.onRestart === "park") return { runId: run.id, step, phase: "park" };
  if (IDLE_WAITS.some((id) => stepIdMatches(id, step))) return undefined;
  const phase = stepPhase(step);
  return DRAIN_PHASES.has(phase) ? { runId: run.id, step, phase: phase as BusyPhase } : undefined;
}

function heldNow(isHeld: HoldPredicate, run: WorkflowRun): boolean {
  try {
    return isHeld(run);
  } catch {
    return false;
  }
}

/** The running runs whose current step a restart would repeat mid-review or mid-merge, or park for a human; a held run in a merge step is not one, since it cannot merge until released. */
export function busyRuns(runs: readonly WorkflowRun[], routeFor: RouteFor, isHeld: HoldPredicate = notHeld): BusyRun[] {
  return runs.flatMap((run) => {
    const busy = classify(run, routeFor);
    return busy && !(busy.phase === "merging" && heldNow(isHeld, run)) ? [busy] : [];
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

export function describeBusy(busy: readonly BusyRun[], held: readonly BusyRun[] = []): string {
  const lines = busy.map((run) => `  ${run.runId} ${run.step} (${run.phase})\n`);
  return [...lines, ...held.map((run) => `  ${run.runId} ${run.step} (held, not waited for)\n`)].join("");
}

/** Poll `/health` until no run is busy or the deadline passes; only a busy park-routed step refuses, and `force` overrides it. A poll with no answer is unknown, not idle. */
export async function drainForRestart(ports: DrainPorts, report: (text: string) => void, options: DrainOptions): Promise<DrainOutcome> {
  const deadline = ports.now() + options.timeoutMs;
  const reporter = everyMinute(ports, report);
  let silentSince: number | null = null;
  for (;;) {
    const health = await ports.health(options.port);
    if (health === null && options.wait) {
      silentSince ??= ports.now();
      if (silentLongEnough(ports, silentSince, deadline, report)) return { proceed: true };
      reporter("serve did not answer /health; still draining");
    } else {
      silentSince = null;
      const outcome = answered(health, ports.now() >= deadline, options, report);
      if (outcome) return outcome;
      reporter(`waiting for ${readBusy(health).length} busy run(s) before restarting:\n${describeBusy(readBusy(health), readHeldSkipped(health))}`);
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
function answered(health: Record<string, unknown> | null, pastDeadline: boolean, options: DrainOptions, report: (text: string) => void): DrainOutcome | undefined {
  const busy = readBusy(health);
  const held = readHeldSkipped(health);
  if (busy.length === 0) {
    if (held.length > 0) report(`restarting without waiting for ${held.length} held run(s):\n${describeBusy([], held)}`);
    return { proceed: true };
  }
  return !options.wait || pastDeadline ? atDeadline(busy, options, report) : undefined;
}

function atDeadline(busy: readonly BusyRun[], options: DrainOptions, report: (text: string) => void): DrainOutcome {
  const parked = busy.filter((run) => run.phase === "park");
  const stopped = options.wait ? "the drain timed out" : "--no-drain skipped the wait";
  if (parked.length > 0 && !options.force) {
    return { proceed: false, why: `${stopped} with a park-routed step busy; a restart now leaves its run recovery_required. Wait, or rerun with --force:\n${describeBusy(parked)}` };
  }
  report(`${stopped}; restarting with ${busy.length} busy run(s):\n${describeBusy(busy)}`);
  return { proceed: true };
}
