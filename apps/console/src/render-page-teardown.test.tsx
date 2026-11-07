// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { unmountPages } from "./render-page.test-helpers.js";

describe("unmountPages", () => {
  it("waits for the immediate queue the scheduler uses, not only for a timeout", async () => {
    const queueImmediate = vi.spyOn(globalThis, "setImmediate");

    await unmountPages();

    expect(queueImmediate).toHaveBeenCalled();
    queueImmediate.mockRestore();
  });

  it("runs scheduler work that earlier scheduler work queued, however many hops deep", async () => {
    let hopsRun = 0;
    const queueNext = (): void => {
      // Alternating the two queues makes each hop wait for the next pass of the drain.
      const queue = hopsRun % 2 === 0 ? setImmediate : (run: () => void) => setTimeout(run, 0);
      queue(() => {
        hopsRun += 1;
        if (hopsRun < 6) queueNext();
      });
    };
    queueNext();

    await unmountPages();

    expect(hopsRun).toBe(6);
  });
});
