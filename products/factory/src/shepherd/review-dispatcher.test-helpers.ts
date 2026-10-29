import { vi } from "vitest";
import type { ReviewAsk } from "./review-queue.js";
import { movedPastOnList } from "./review-queue.js";
import { spawnGate, type MachineReadings } from "./spawn-gate.js";

export const idle: MachineReadings = { load5: 2, pressureLevel: 1, freeMemoryPct: 85 };
const busy: MachineReadings = { ...idle, load5: 30 };
export const HEAD_A = "a".repeat(40);
export const HEAD_B = "b".repeat(40);
export const TICK_MS = 60_000;

/** A gate with one review slot on a faked clock; `queue` records each launch and leaves the outcome on `settled`. */
export function scene(options: { list?: () => { at: number; prs: { number: number; headSha: string }[] }; liveHead?: () => Promise<string | undefined> } = {}) {
  const state = { readings: busy, running: [] as number[], launched: [] as string[], settled: new Map<string, string>(), errors: new Map<string, unknown>() };
  const ports = { ...(options.list && { movedPast: movedPastOnList(options.list) }), ...(options.liveHead && { liveHead: options.liveHead }) };
  const gate = spawnGate({ limits: { maxConcurrentReviews: 1 }, read: () => state.readings, log: () => undefined, tickMs: TICK_MS, ...ports });
  const queue = (name: string, review: ReviewAsk, signal?: AbortSignal) => {
    const launch = async () => void state.launched.push(name);
    gate.queueReview(name, review, { running: async () => state.running, launch, ...(signal && { signal }) }).then(
      () => state.settled.set(name, "launched"),
      (error: unknown) => {
        state.errors.set(name, error);
        state.settled.set(name, error instanceof Error ? error.name : String(error));
      },
    );
  };
  return { state, gate, queue };
}

export const flush = () => vi.advanceTimersByTimeAsync(0);
export const target = (pr: number, head = HEAD_A) => ({ repo: "octo/demo", pr, head });
