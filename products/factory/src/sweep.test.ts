import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSweep } from "./sweep.js";

afterEach(() => vi.useRealTimers());

describe("startSweep", () => {
  it("halt stops future ticks but leaves the in-flight one", async () => {
    vi.useFakeTimers();
    let finish = (): void => undefined;
    const tickOnce = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const sweep = startSweep(tickOnce, 100, "test sweep", silentLogger);
    void sweep.tick();

    sweep.halt();
    await vi.advanceTimersByTimeAsync(500);
    void sweep.tick();

    expect(tickOnce).toHaveBeenCalledTimes(1);
    expect(sweep.inFlight()).not.toBeNull();
    finish();
    await sweep.inFlight();
    expect(sweep.inFlight()).toBeNull();
  });

  it("a failing tick is logged and its in-flight promise still resolves", async () => {
    const errors: unknown[] = [];
    const log = { ...silentLogger, error: (_fields: unknown, msg?: unknown) => void errors.push(msg) };
    const sweep = startSweep(() => Promise.reject(new Error("database closed")), 60_000, "test sweep", log);
    void sweep.tick();

    await sweep.inFlight();
    sweep.halt();

    expect(errors).toEqual(["test sweep failed"]);
  });
});
