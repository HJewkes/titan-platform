import { stopEvals } from "./autoresearch/run-command.js";

interface ProcessOwner {
  /** Stops new work from starting here: serve halts its sweeps, the CLI quiesces its runtime so no drive re-claims a run. */
  stopAdmission(): void;
  runtime: { shutdown(): void };
}

/**
 * The one shutdown of a process that drives runs, shared by serve and the CLI. The runtime aborts its runs with
 * RuntimeShutdown before any eval group is signalled, so an eval that dies first reads as a shutdown, never as a failed
 * row or a failed run. It returns and never exits: the caller owns the exit.
 */
export function shutdownOwner(owner: ProcessOwner): Promise<void> {
  owner.stopAdmission();
  owner.runtime.shutdown();
  return stopEvals();
}
