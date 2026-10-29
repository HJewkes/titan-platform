import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSuperseded } from "./review-dispatcher.js";
import { HEAD_A, HEAD_B, TICK_MS, flush, idle, scene, target } from "./review-dispatcher.test-helpers.js";
import { spawnQueuePosition } from "./review-queue.js";
import { SpawnDeferred } from "./spawn-gate.js";

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

  it("gives up on a review still queued after the hold, as a deferral its step reports", async () => {
    const { state, queue } = scene();
    queue("rv-demo-7", { fixer: false });

    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);

    expect(state.launched).toEqual([]);
    expect(state.settled.get("rv-demo-7")).toBe(new SpawnDeferred("").name);
  });
});
