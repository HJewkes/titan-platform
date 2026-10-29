import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSuperseded } from "./review-dispatcher.js";
import { notStarted } from "./review-wait.js";
import { movedPastOnList, spawnQueuePosition, type ReviewAsk } from "./review-queue.js";
import { spawnGate, SpawnDeferred, type MachineReadings } from "./spawn-gate.js";

const idle: MachineReadings = { load5: 2, pressureLevel: 1, freeMemoryPct: 85 };
const busy: MachineReadings = { ...idle, load5: 30 };
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const TICK_MS = 60_000;

/** A gate with one review slot on a faked clock; `queue` records each launch and leaves the outcome on `settled`. */
function scene(options: { list?: () => { at: number; prs: { number: number; headSha: string }[] }; liveHead?: () => Promise<string | undefined> } = {}) {
  const state = { readings: busy, running: [] as number[], launched: [] as string[], settled: new Map<string, string>(), errors: new Map<string, unknown>() };
  const gate = spawnGate({ limits: { maxConcurrentReviews: 1 }, read: () => state.readings, log: () => undefined, tickMs: TICK_MS, ...(options.list && { movedPast: movedPastOnList(options.list) }), ...(options.liveHead && { liveHead: options.liveHead }) });
  const queue = (name: string, review: ReviewAsk) => {
    const launch = async () => void state.launched.push(name);
    gate.queueReview(name, review, { running: async () => state.running, launch }).then(
      () => state.settled.set(name, "launched"),
      (error: unknown) => {
        state.errors.set(name, error);
        state.settled.set(name, error instanceof Error ? error.name : String(error));
      },
    );
  };
  return { state, gate, queue };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const target = (pr: number, head = HEAD_A) => ({ repo: "octo/demo", pr, head });

describe("the push dispatcher starts reviews from the one queue on its three triggers", () => {
  beforeEach(() => void vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => void vi.useRealTimers());

  it("starts a review on enqueue when the machine has room, with no wait", async () => {
    const { state, queue } = scene();
    state.readings = idle;

    queue("rv-demo-7", { fixer: false, target: target(7) });
    await flush();

    expect(state.launched).toEqual(["rv-demo-7"]);
    expect(state.settled.get("rv-demo-7")).toBe("launched");
  });

  it("starts exactly the queue's front when a review ends and frees the slot", async () => {
    const { state, gate, queue } = scene();
    state.readings = idle;
    state.running = [0];
    queue("rv-demo-7", { fixer: false, intentAt: 10_000 });
    queue("rv-demo-8", { fixer: false, intentAt: 20_000 });
    await flush();
    expect(state.launched).toEqual([]);

    state.running = [];
    gate.reviewEnded();
    await flush();

    expect(state.launched).toEqual(["rv-demo-7"]);
  });

  it("starts exactly the queue's front on the tick once the machine settles, and nothing between ticks", async () => {
    const { state, queue } = scene();
    queue("rv-demo-8", { fixer: false, intentAt: 20_000 });
    queue("rv-demo-7", { fixer: false, intentAt: 10_000 });
    await flush();
    state.readings = idle;

    await vi.advanceTimersByTimeAsync(TICK_MS - 1);
    expect(state.launched).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.launched).toEqual(["rv-demo-7"]);
  });

  it("never starts a queued review whose pull request moved to a new head, and tells its waiter at once", async () => {
    const list = { at: 0, prs: [{ number: 7, headSha: HEAD_A }] };
    const { state, gate, queue } = scene({ list: () => list });
    queue("rv-demo-7", { fixer: false, intentAt: 10_000, target: target(7) });
    await flush();
    expect(spawnQueuePosition("octo/demo", 7)).toBe("position 1 of 1");

    Object.assign(list, { at: Date.now(), prs: [{ number: 7, headSha: HEAD_B }] });
    state.readings = idle;
    gate.reviewEnded();
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(state.launched).toEqual([]);
    expect(state.settled.get("rv-demo-7")).toBe(new ReviewSuperseded("").name);
    expect(spawnQueuePosition("octo/demo", 7)).toBeUndefined();
  });

  it("a gate-deferred review whose head moves finishes superseded and leaves the queue", async () => {
    const live = { head: HEAD_A };
    const { state, queue } = scene({ liveHead: async () => live.head });
    queue("rv-demo-7", { fixer: false, intentAt: 10_000, target: target(7) });
    await flush();
    expect(spawnQueuePosition("octo/demo", 7)).toBe("position 1 of 1");

    live.head = HEAD_B;
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(state.launched).toEqual([]);
    expect(state.settled.get("rv-demo-7")).toBe(new ReviewSuperseded("").name);
    expect(notStarted(state.errors.get("rv-demo-7"), [])).toEqual({ kind: "none", reason: `superseded: the pull request moved from head ${HEAD_A} to ${HEAD_B}` });
    expect(spawnQueuePosition("octo/demo", 7)).toBeUndefined();
  });

  it("gives up on a review still queued after the hold, as a deferral its step reports", async () => {
    const { state, queue } = scene();
    queue("rv-demo-7", { fixer: false });

    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);

    expect(state.launched).toEqual([]);
    expect(state.settled.get("rv-demo-7")).toBe(new SpawnDeferred("").name);
  });
});
