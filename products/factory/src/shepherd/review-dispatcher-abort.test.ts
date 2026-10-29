import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnQueuePosition } from "./review-queue.js";
import { flush, idle, scene, target } from "./review-dispatcher.test-helpers.js";

describe("the push dispatcher drops a queued review whose step aborts", () => {
  beforeEach(() => void vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => void vi.useRealTimers());

  it("rejects a queued review at once when its step aborts, never launches it, and frees its place in the queue", async () => {
    const { state, gate, queue } = scene();
    const step = new AbortController();
    queue("rv-demo-7", { fixer: false, intentAt: 10_000, target: target(7) }, step.signal);
    queue("rv-demo-8", { fixer: false, intentAt: 20_000, target: target(8) });
    await flush();
    expect(spawnQueuePosition("octo/demo", 8)).toBe("position 2 of 2");

    step.abort(new Error("RuntimeShutdown"));
    await flush();
    expect(state.settled.get("rv-demo-7")).toBe("Error");
    expect(spawnQueuePosition("octo/demo", 7)).toBeUndefined();
    expect(spawnQueuePosition("octo/demo", 8)).toBe("position 1 of 1");
    state.readings = idle;
    gate.reviewEnded();
    await flush();

    expect(state.launched).toEqual(["rv-demo-8"]);
  });

  it("never queues a review whose step aborted before it asked", async () => {
    const { state, queue } = scene();
    state.readings = idle;

    queue("rv-demo-7", { fixer: false, target: target(7) }, AbortSignal.abort(new Error("cancelled")));
    await flush();

    expect(state.launched).toEqual([]);
    expect(state.settled.get("rv-demo-7")).toBe("Error");
    expect(spawnQueuePosition("octo/demo", 7)).toBeUndefined();
  });
});
