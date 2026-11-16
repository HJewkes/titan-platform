// @vitest-environment jsdom
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { drainScheduler } from "./drain-scheduler.js";

interface Scheduler {
  readonly unstable_NormalPriority: number;
  readonly unstable_IdlePriority: number;
  unstable_scheduleCallback(priority: number, callback: () => void): { readonly id: number };
}

const requireHere = createRequire(import.meta.url);
const scheduler = createRequire(requireHere.resolve("react-dom"))("scheduler") as Scheduler;

function busyFor(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

describe("draining React's scheduler before jsdom teardown", () => {
  it("a task queued like a passive-effect flush has run once the drain resolves", async () => {
    const ran: string[] = [];
    scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => ran.push(String(window.event)));

    await drainScheduler(scheduler);

    expect(ran).toEqual(["undefined"]);
  });

  it("tasks queued after the scheduler yields mid-queue still run", async () => {
    const ran: number[] = [];
    for (let index = 0; index < 4; index++) {
      scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
        busyFor(8);
        ran.push(index);
      });
    }

    await drainScheduler(scheduler);

    expect(ran).toEqual([0, 1, 2, 3]);
  });

  it("a task one task queues through a resolved promise runs in the same drain", async () => {
    const ran: string[] = [];
    scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
      ran.push("first");
      void Promise.resolve().then(() =>
        setTimeout(() => scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => ran.push("second")), 0),
      );
    });

    await drainScheduler(scheduler);

    expect(ran).toEqual(["first", "second"]);
  });

  it("a scheduler that never runs its queue releases the drain at the deadline", async () => {
    let id = 0;
    const stalled = { unstable_IdlePriority: 5, unstable_scheduleCallback: () => ({ id: id++ }) };
    const startedAt = performance.now();

    await drainScheduler(stalled);

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_900);
  });
});
