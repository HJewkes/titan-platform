import { describe, expect, it } from "vitest";
import { FAST_PROBE_TIMEOUT_MS, SLOW_PROBE_TIMEOUT_MS, watchServe, type WatchWindow } from "./deploy-watch-window.js";

const TARGET = "a".repeat(40);
const PID = 4242;
const WINDOW: WatchWindow = { windowMs: 60_000, intervalMs: 10_000, missLimit: 3 };
const baseline = { ok: true, pid: PID, build: { sha: TARGET }, runs: { failed: 0 } };

type Step = "answer" | "refused" | "stall" | "slow-answer";

/** Each tick consumes one step; a stall holds the probe for its whole timeout, a slow answer returns after the quick timeout. */
function scripted(steps: Step[], alive = true) {
  let clock = 0;
  let tick = -1;
  const timeouts: number[] = [];
  const ports = {
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
    alive: (pid: number) => alive && pid === PID,
    probe: async (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      const retry = timeoutMs === SLOW_PROBE_TIMEOUT_MS;
      if (!retry) tick += 1;
      const step = steps[Math.min(tick, steps.length - 1)];
      if (step === "answer") return baseline;
      if (step === "refused") return null;
      if (!retry) {
        clock += timeoutMs;
        return null;
      }
      if (step === "slow-answer") {
        clock += 12_000;
        return baseline;
      }
      clock += timeoutMs;
      return null;
    },
  };
  return { ports, timeouts };
}

describe("watchServe slow versus down", () => {
  it("rolls back on a refused connection after the miss limit when the pid is gone", async () => {
    const { ports, timeouts } = scripted(["answer", "refused"], false);

    const why = await watchServe(ports, baseline, TARGET, WINDOW);

    expect(why).toContain("serve stopped answering /health (3 probes in a row)");
    expect(timeouts).not.toContain(SLOW_PROBE_TIMEOUT_MS);
  });

  it("does not count timed-out probes from the live pid toward the miss limit", async () => {
    const { ports } = scripted(["answer", "stall", "stall", "stall", "stall", "answer"]);

    const why = await watchServe(ports, baseline, TARGET, WINDOW);

    expect(why).toBeUndefined();
  });

  it("retries a timed-out probe from the live pid with the 30 s timeout", async () => {
    const { ports, timeouts } = scripted(["answer", "slow-answer", "answer"]);

    await watchServe(ports, baseline, TARGET, WINDOW);

    expect(timeouts.slice(0, 4)).toEqual([FAST_PROBE_TIMEOUT_MS, FAST_PROBE_TIMEOUT_MS, SLOW_PROBE_TIMEOUT_MS, FAST_PROBE_TIMEOUT_MS]);
  });

  it("rolls back naming the latencies when every probe in the window was slow", async () => {
    const { ports } = scripted(["slow-answer", "stall"]);

    const why = await watchServe(ports, baseline, TARGET, WINDOW);

    expect(why).toContain("serve answered slowly on every probe (");
    expect(why).toContain("17.0 s");
    expect(why).toContain("no answer in 35 s");
  });

  it("passes a zero-length window without probing", async () => {
    const { ports, timeouts } = scripted(["stall"]);

    const why = await watchServe(ports, baseline, TARGET, { ...WINDOW, windowMs: 0 });

    expect(why).toBeUndefined();
    expect(timeouts).toEqual([]);
  });

  it("keeps a window with some quick answers, however slow the others were", async () => {
    const { ports } = scripted(["slow-answer", "stall", "answer"]);

    expect(await watchServe(ports, baseline, TARGET, WINDOW)).toBeUndefined();
  });

  it("mixes: slow probes do not reset a down streak into a pass, and a dead pid after stalls still rolls back", async () => {
    const alive = { value: true };
    const { ports } = scripted(["answer", "stall", "stall"]);
    const dying = { ...ports, alive: () => alive.value, sleep: async (ms: number) => { await ports.sleep(ms); if (ports.now() > 30_000) alive.value = false; } };

    const why = await watchServe(dying, baseline, TARGET, WINDOW);

    expect(why).toContain("serve stopped answering /health (3 probes in a row)");
  });
});
