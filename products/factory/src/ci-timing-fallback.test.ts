import { silentLogger as log } from "@titan-design/daemon";
import { describe, expect, it, vi } from "vitest";
import { ciTimingFallbackTick, shouldDispatchCiTiming, type CiTimingFallbackPorts } from "./ci-timing-fallback.js";

const at = (iso: string) => Date.parse(iso);

function ports(runExists: boolean, clock: { t: number }) {
  const dispatch = vi.fn(async () => {});
  const fake: CiTimingFallbackPorts = { repo: "example/repo", hasRunOn: async () => runExists, dispatch, now: () => clock.t };
  return { fake, dispatch };
}

describe("CI timing fallback", () => {
  it("does not dispatch when a run already exists for the day", async () => {
    const { fake, dispatch } = ports(true, { t: at("2026-11-02T15:00:00Z") });
    await ciTimingFallbackTick(fake, log)();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches exactly once when no run exists and the time is past 14:00Z", async () => {
    const { fake, dispatch } = ports(false, { t: at("2026-11-02T14:00:00Z") });
    await ciTimingFallbackTick(fake, log)();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch again on a second tick the same day", async () => {
    const clock = { t: at("2026-11-02T14:30:00Z") };
    const { fake, dispatch } = ports(false, clock);
    const tick = ciTimingFallbackTick(fake, log);
    await tick();
    clock.t = at("2026-11-02T14:40:00Z");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches again on the next UTC day", async () => {
    const clock = { t: at("2026-11-02T14:30:00Z") };
    const { fake, dispatch } = ports(false, clock);
    const tick = ciTimingFallbackTick(fake, log);
    await tick();
    clock.t = at("2026-11-03T14:30:00Z");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch before 14:00Z", async () => {
    const { fake, dispatch } = ports(false, { t: at("2026-11-02T13:59:59Z") });
    await ciTimingFallbackTick(fake, log)();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("decides on the three facts alone", () => {
    const now = new Date("2026-11-02T20:00:00Z");
    expect(shouldDispatchCiTiming({ now, runExists: false, dispatchedDay: "2026-11-02" })).toBe(false);
    expect(shouldDispatchCiTiming({ now, runExists: false, dispatchedDay: "2026-11-01" })).toBe(true);
  });
});
