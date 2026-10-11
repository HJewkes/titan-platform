import { describe, expect, it } from "vitest";
import { awaitLift, machineStopWatch, stopReason } from "./machine-stop.js";
import type { MachineReadings } from "./spawn-gate.js";
import { DEFAULT_HOLD_WAIT_MS } from "./review-wait.js";

const CLEAR: MachineReadings = { load5: 1, pressureLevel: 1, freeMemoryPct: 50 };
const STOPPED: MachineReadings = { load5: 40, pressureLevel: 1, freeMemoryPct: 50 };

describe("stopReason", () => {
  it("names a load5 past the limit", () => {
    expect(stopReason({ ...CLEAR, load5: 29 })).toBe("load5 29 (limit 28)");
  });

  it("is clear at a load5 equal to the limit", () => {
    expect(stopReason({ ...CLEAR, load5: 28 })).toBeUndefined();
  });

  it("stops at the warn pressure level even under a low load", () => {
    expect(stopReason({ ...CLEAR, pressureLevel: 2 })).toBe("memory pressure level 2 (limit 2)");
  });

  it("stops when free memory is under the floor", () => {
    expect(stopReason({ ...CLEAR, freeMemoryPct: 19 })).toBe("free memory 19% (limit 20%)");
  });

  it("never stops on an unread pressure or free memory reading", () => {
    expect(stopReason({ load5: 1 })).toBeUndefined();
  });

  it("applies the limits it is given", () => {
    expect(stopReason({ ...CLEAR, load5: 11 }, { load5: 10, pressureLevel: 2, freeMemoryPct: 20 })).toBe("load5 11 (limit 10)");
  });
});

describe("machineStopWatch ledger", () => {
  const watch = () => machineStopWatch({ read: () => CLEAR });

  it("returns a stop noted at or after the time asked about", () => {
    const stops = watch();
    stops.note(100, "load5 40 (limit 28)");
    expect(stops.stoppedSince(50)).toBe("load5 40 (limit 28)");
    expect(stops.stoppedSince(100)).toBe("load5 40 (limit 28)");
  });

  it("ignores a stop noted before the time asked about", () => {
    const stops = watch();
    stops.note(100, "load5 40 (limit 28)");
    expect(stops.stoppedSince(150)).toBeUndefined();
  });

  it("answers the newest stop since the time asked about", () => {
    const stops = watch();
    stops.note(1_000, "load5 40 (limit 28)");
    stops.note(5 * 60_000, "memory pressure level 4 (limit 2)");
    expect(stops.stoppedSince(0)).toBe("memory pressure level 4 (limit 2)");
  });

  it("forgets stops older than the hold ceiling", () => {
    const stops = watch();
    stops.note(0, "load5 40 (limit 28)");
    stops.note(DEFAULT_HOLD_WAIT_MS + 60_000, "load5 30 (limit 28)");
    expect(stops.stoppedSince(0)).toBe("load5 30 (limit 28)");
    expect(stops.stoppedSince(-1)).toBe("load5 30 (limit 28)");
    stops.note(DEFAULT_HOLD_WAIT_MS + 120_000, "load5 31 (limit 28)");
    expect(stops.stoppedSince(0)).toBe("load5 31 (limit 28)");
  });

  it("notes the stop a sample reads, at the watch's clock", () => {
    const stops = machineStopWatch({ read: () => STOPPED, now: () => 500 });
    expect(stops.sample()).toBe("load5 40 (limit 28)");
    expect(stops.stoppedSince(500)).toBe("load5 40 (limit 28)");
  });

  it("notes nothing when a sample reads a clear machine", () => {
    const stops = machineStopWatch({ read: () => CLEAR, now: () => 500 });
    expect(stops.sample()).toBeUndefined();
    expect(stops.stoppedSince(0)).toBeUndefined();
  });
});

function sequence(readings: MachineReadings[]) {
  let now = 0;
  let sleeps = 0;
  const reads = [...readings];
  const watch = machineStopWatch({ read: () => (reads.length > 1 ? reads.shift()! : reads[0]!), now: () => now });
  const timing = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps += 1;
      now += ms;
    },
    pollMs: 60_000,
  };
  return { watch, timing, sleeps: () => sleeps };
}

describe("awaitLift", () => {
  it("lifts once the machine reads clear, after sleeping through the stopped reads", async () => {
    const { watch, timing, sleeps } = sequence([STOPPED, STOPPED, CLEAR]);
    await expect(awaitLift(watch, timing, new AbortController().signal)).resolves.toEqual({ lifted: true });
    expect(sleeps()).toBe(2);
  });

  it("answers not lifted with the last reason when the stop outlasts the ceiling", async () => {
    const { watch, timing } = sequence([STOPPED]);
    const lift = await awaitLift(watch, timing, new AbortController().signal, 5 * 60_000);
    expect(lift).toEqual({ lifted: false, reason: "load5 40 (limit 28)" });
    expect(timing.now()).toBe(5 * 60_000);
  });

  it("stops waiting when the signal aborts", async () => {
    const { watch, timing } = sequence([STOPPED]);
    const controller = new AbortController();
    controller.abort();
    await expect(awaitLift(watch, timing, controller.signal)).rejects.toThrow();
  });
});
