import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

interface SchedulerTask {
  readonly id: number;
}

interface Scheduler {
  readonly unstable_IdlePriority: number;
  readonly unstable_NormalPriority: number;
  unstable_scheduleCallback(priority: number, callback: () => void): SchedulerTask;
}

const MAX_DRAIN_PASSES = 50;
// A drain that cannot finish (a scheduler whose host loop was captured from fake timers) must not hold afterAll to the
// hook timeout; the file then ends as it did before the drain existed.
const DRAIN_DEADLINE_MS = 2_000;

// react-dom requires its own copy of scheduler; resolving from react-dom's path loads that same module instance, whose
// queue is the one a commit's passive-effect flush waits in.
export function reactDomScheduler(): Scheduler {
  const requireHere = createRequire(import.meta.url);
  const scheduler: unknown = createRequire(requireHere.resolve("react-dom"))("scheduler");
  if (!isScheduler(scheduler)) throw new Error("react-dom's scheduler has no unstable_scheduleCallback");
  return scheduler;
}

function isScheduler(value: unknown): value is Scheduler {
  return typeof value === "object" && value !== null && "unstable_scheduleCallback" in value;
}

function runAfterQueuedTasks(scheduler: Scheduler): Promise<SchedulerTask> {
  return new Promise((resolve) => {
    // Idle work expires last, so the scheduler runs every task queued ahead of this one, or queued while it waits, first.
    const task = scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, () => resolve(task));
  });
}

async function drainUntilQuiet(scheduler: Scheduler): Promise<void> {
  let previous = await runAfterQueuedTasks(scheduler);
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
    // node:timers, not the global a file may have faked, so a follow-up queued through a timer gets its turn.
    await sleep(0);
    const next = await runAfterQueuedTasks(scheduler);
    if (next.id === previous.id + 1) return;
    previous = next;
  }
}

/**
 * Runs every task React left in the scheduler, while the file's jsdom still exists. A commit made outside `act` hands
 * its passive-effect flush to the scheduler, whose callback reads `window.event`; under a full suite's load that task
 * can outlive the file's jsdom and throw "window is not defined" (TP-6597, TP-4769). A task that runs can queue more
 * through promises and timers, so passes repeat until one sees no task queued since the last.
 */
export async function drainScheduler(scheduler: Scheduler = reactDomScheduler()): Promise<void> {
  const deadline = new AbortController();
  // Aborting the deadline once the drain wins rejects its sleep; that rejection is the expected way it ends.
  const expired = sleep(DRAIN_DEADLINE_MS, undefined, { signal: deadline.signal }).catch(() => undefined);
  try {
    await Promise.race([drainUntilQuiet(scheduler), expired]);
  } finally {
    deadline.abort();
  }
}
