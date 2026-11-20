import { describe, expect, it } from "vitest";
import { settleBounded } from "./bounded.js";

describe("settleBounded", () => {
  it("never has more than the limit in flight and runs every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];

    await settleBounded([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(item);
      inFlight--;
    });

    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("counts a rejection and goes on with the rest", async () => {
    const seen: number[] = [];

    const failed = await settleBounded([1, 2, 3], 1, async (item) => {
      seen.push(item);
      if (item === 2) throw new Error("down");
    });

    expect(failed).toBe(1);
    expect(seen).toEqual([1, 2, 3]);
  });
});
