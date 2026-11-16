import { createRequire } from "node:module";

interface SchedulerTask {
  readonly id: number;
}

interface Scheduler {
  readonly unstable_IdlePriority: number;
  unstable_scheduleCallback(priority: number, callback: () => void): SchedulerTask;
}

const MAX_DRAIN_PASSES = 50;

// react-dom requires its own copy of scheduler; resolving from react-dom's path loads that same module instance, whose
// queue is the one a commit's passive-effect flush waits in.
function reactDomScheduler(): Scheduler {
  const requireHere = createRequire(import.meta.url);
  return createRequire(requireHere.resolve("react-dom"))("scheduler") as Scheduler;
}

function runAfterQueuedTasks(scheduler: Scheduler): Promise<SchedulerTask> {
  return new Promise((resolve) => {
    // Idle work expires last, so the scheduler runs every task queued ahead of this one, or queued while it waits, first.
    const task = scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, () => resolve(task));
  });
}

/**
 * Runs every task React left in the scheduler, while the file's jsdom still exists. A commit made outside `act` hands
 * its passive-effect flush to the scheduler, whose callback reads `window.event`; under a full suite's load that task
 * can outlive the file and throw "window is not defined" from the next file's node environment (TP-6597, TP-4769).
 * A task that runs can queue more through promises, so passes repeat until one sees no task queued since the last.
 */
export async function drainScheduler(scheduler: Scheduler = reactDomScheduler()): Promise<void> {
  let previous = await runAfterQueuedTasks(scheduler);
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const next = await runAfterQueuedTasks(scheduler);
    if (next.id === previous.id + 1) return;
    previous = next;
  }
}
