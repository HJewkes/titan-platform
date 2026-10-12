import { describe, expect, it } from "vitest";
import { SLICE_MS, sliceClock } from "./loop-slice.js";

describe("sliceClock", () => {
  it("lets queued callbacks run once a slice of work is spent, and not before", async () => {
    let clock = 0;
    const pause = sliceClock(() => clock);
    const ran: string[] = [];
    setImmediate(() => ran.push("callback"));

    clock = SLICE_MS - 1;
    await pause();
    ran.push("short slice");
    clock = SLICE_MS;
    await pause();
    ran.push("full slice");

    expect(ran).toEqual(["short slice", "callback", "full slice"]);
  });
});
