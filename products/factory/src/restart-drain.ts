import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { stepPhase } from "./shepherd/view.js";

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
const DRAIN_PHASES: ReadonlySet<string> = new Set(["review", "merging"]);

type RouteFor = (stepId: string) => Pick<StepRoute, "onRestart"> | undefined;

/** The running runs whose current step a restart would repeat mid-review or mid-merge, or park for a human. */
export function busyRuns(runs: readonly WorkflowRun[], routeFor: RouteFor): BusyRun[] {
  return runs.flatMap((run): BusyRun[] => {
    const step = run.currentStep;
    if (run.status !== "running" || step === null) return [];
    if (routeFor(step)?.onRestart === "park") return [{ runId: run.id, step, phase: "park" }];
    const phase = stepPhase(step);
    return DRAIN_PHASES.has(phase) ? [{ runId: run.id, step, phase: phase as BusyPhase }] : [];
  });
}

/** A build from before the busy field, or no answer at all, has nothing to drain. */
export function readBusy(health: Record<string, unknown> | null): BusyRun[] {
  return Array.isArray(health?.busy) ? (health.busy as BusyRun[]) : [];
}

export function describeBusy(busy: readonly BusyRun[]): string {
  return busy.map((run) => `  ${run.runId} ${run.step} (${run.phase})\n`).join("");
}

/** Poll `/health` until no run is busy or the deadline passes; only a busy park-routed step refuses, and `force` overrides it. */
export async function drainForRestart(ports: DrainPorts, report: (text: string) => void, options: DrainOptions): Promise<DrainOutcome> {
  const deadline = ports.now() + options.timeoutMs;
  let nextReport = ports.now();
  for (;;) {
    const busy = readBusy(await ports.health(options.port));
    if (busy.length === 0) return { proceed: true };
    if (!options.wait || ports.now() >= deadline) return atDeadline(busy, options, report);
    if (ports.now() >= nextReport) {
      report(`waiting for ${busy.length} busy run(s) before restarting:\n${describeBusy(busy)}`);
      nextReport = ports.now() + REPORT_EVERY_MS;
    }
    await ports.sleep(DRAIN_POLL_MS);
  }
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
