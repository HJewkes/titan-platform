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

  it("dispatches exactly once when no run exists and the time is past 17:00Z", async () => {
    const { fake, dispatch } = ports(false, { t: at("2026-11-02T17:00:00Z") });
    await ciTimingFallbackTick(fake, log)();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch again on a second tick the same day", async () => {
    const clock = { t: at("2026-11-02T17:30:00Z") };
    const { fake, dispatch } = ports(false, clock);
    const tick = ciTimingFallbackTick(fake, log);
    await tick();
    clock.t = at("2026-11-02T17:40:00Z");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches again on the next UTC day", async () => {
    const clock = { t: at("2026-11-02T17:30:00Z") };
    const { fake, dispatch } = ports(false, clock);
    const tick = ciTimingFallbackTick(fake, log);
    await tick();
    clock.t = at("2026-11-03T17:30:00Z");
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch before 17:00Z", async () => {
    const { fake, dispatch } = ports(false, { t: at("2026-11-02T16:59:59Z") });
    await ciTimingFallbackTick(fake, log)();
    expect(dispatch).not.toHaveBeenCalled();
  });

  const observedScheduleRuns = ["2026-11-02T15:46:42Z", "2026-11-03T14:09:17Z", "2026-11-04T14:28:43Z", "2026-11-05T14:36:51Z", "2026-11-06T14:13:52Z"];

  it.each(observedScheduleRuns)("does not dispatch before the late schedule run of %s arrives", async (arrival) => {
    const clock = { t: at(arrival) - 60_000 };
    const { fake, dispatch } = ports(false, clock);
    const tick = ciTimingFallbackTick(fake, log);
    await tick();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(observedScheduleRuns)("does not dispatch once the late schedule run of %s exists", async (arrival) => {
    const { fake, dispatch } = ports(true, { t: at(arrival) + 60_000 });
    await ciTimingFallbackTick(fake, log)();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches once when the deadline passes with no run", async () => {
    const clock = { t: at("2026-11-06T14:08:42Z") };
    const { fake, dispatch } = ports(false, clock);
    const tick = ciTimingFallbackTick(fake, log);
    await tick();
    clock.t = at("2026-11-06T17:01:00Z");
    await tick();
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("decides on the three facts alone", () => {
    const now = new Date("2026-11-02T20:00:00Z");
    expect(shouldDispatchCiTiming({ now, runExists: false, dispatchedDay: "2026-11-02" })).toBe(false);
    expect(shouldDispatchCiTiming({ now, runExists: false, dispatchedDay: "2026-11-01" })).toBe(true);
  });
});
