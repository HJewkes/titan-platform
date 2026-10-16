import { describe, expect, it } from "vitest";
import { DEFAULT_WATCH_WINDOW, FAST_PROBE_TIMEOUT_MS, SLOW_PROBE_TIMEOUT_MS, UNAVAILABLE, watchServe, type WatchIntent, type WatchWindow } from "./deploy-watch-window.js";

const TARGET = "a".repeat(40);
const PID = 4242;
const WINDOW: WatchWindow = { windowMs: 60_000, intervalMs: 10_000, missLimit: 3 };
const baseline = { ok: true, pid: PID, build: { sha: TARGET }, runs: { failed: 0 } };
const settled = { confirmed: baseline, atRestart: null };

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

    const why = await watchServe(ports, settled, TARGET, WINDOW);

    expect(why).toContain("serve stopped answering /health (3 probes in a row)");
    expect(timeouts).not.toContain(SLOW_PROBE_TIMEOUT_MS);
  });

  it("does not count answers that needed the retry toward the miss limit", async () => {
    const { ports } = scripted(["answer", "slow-answer", "slow-answer", "slow-answer", "slow-answer", "answer"]);

    const why = await watchServe(ports, settled, TARGET, WINDOW);

    expect(why).toBeUndefined();
  });

  it("retries a timed-out probe from the live pid with the 30 s timeout", async () => {
    const { ports, timeouts } = scripted(["answer", "slow-answer", "answer"]);

    await watchServe(ports, settled, TARGET, WINDOW);

    expect(timeouts.slice(0, 4)).toEqual([FAST_PROBE_TIMEOUT_MS, FAST_PROBE_TIMEOUT_MS, SLOW_PROBE_TIMEOUT_MS, FAST_PROBE_TIMEOUT_MS]);
  });

  it("rolls back after the miss limit when serve answers once and then hangs with its pid alive", async () => {
    const { ports, timeouts } = scripted(["answer", "stall"]);

    const why = await watchServe(ports, settled, TARGET, WINDOW);

    expect(why).toContain("serve stopped answering /health (3 probes in a row)");
    expect(timeouts).toContain(SLOW_PROBE_TIMEOUT_MS);
  });

  it("rolls back naming the latencies when every probe in the window was slow", async () => {
    const { ports } = scripted(["slow-answer", "stall", "slow-answer"]);

    const why = await watchServe(ports, settled, TARGET, WINDOW);

    expect(why).toContain("serve answered slowly on every probe (");
    expect(why).toContain("17.0 s");
    expect(why).toContain("no answer in 35 s");
  });

  it("passes a zero-length window without probing", async () => {
    const { ports, timeouts } = scripted(["stall"]);

    const why = await watchServe(ports, settled, TARGET, { ...WINDOW, windowMs: 0 });

    expect(why).toBeUndefined();
    expect(timeouts).toEqual([]);
  });

  it("keeps a window with some quick answers, however slow the others were", async () => {
    const { ports } = scripted(["slow-answer", "stall", "answer"]);

    expect(await watchServe(ports, settled, TARGET, WINDOW)).toBeUndefined();
  });

  it("counts stalls from a live pid and refusals after it dies in one miss streak", async () => {
    const alive = { value: true };
    const { ports } = scripted(["answer", "stall", "stall"]);
    const dying = { ...ports, alive: () => alive.value, sleep: async (ms: number) => { await ports.sleep(ms); if (ports.now() > 30_000) alive.value = false; } };

    const why = await watchServe(dying, settled, TARGET, WINDOW);

    expect(why).toContain("serve stopped answering /health (3 probes in a row)");
  });

  it("passes the default watch when a restarted serve stalls through two start-up ticks and then answers", async () => {
    const { ports } = scripted(["stall", "stall", "answer"]);

    const why = await watchServe(ports, settled, TARGET, DEFAULT_WATCH_WINDOW);

    expect(why).toBeUndefined();
  });
});

const PARKED_IDS = ["p1", "p2", "p3", "p4", "p5", "p6"];
const busyAt = (ids: readonly string[]) => ids.map((runId) => ({ runId, step: "merge:0", phase: "merging" }));
/** The old serve's last drain answer: 225 failed, none parked, and `busy` still at the restart. */
const drained = (busy: readonly string[]) => ({ ok: true, pid: PID - 1, build: { sha: "b".repeat(40) }, runs: { failed: 225, recovery_required: 0 }, recoveryRequired: [], busy: busyAt(busy) });
const answer = (parked: readonly string[], failed = 225) => ({ ok: true, pid: PID, build: { sha: TARGET }, runs: { failed, recovery_required: parked.length }, recoveryRequired: [...parked] });

/** Each tick answers with the next /health in `answers`, and the last repeats. */
function answering(answers: Record<string, unknown>[]) {
  let clock = 0;
  let tick = 0;
  const recorded: WatchIntent[] = [];
  const ports = {
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
    alive: () => true,
    probe: async () => answers[Math.min(tick++, answers.length - 1)]!,
    record: (intent: WatchIntent) => void recorded.push(intent),
  };
  return { ports, recorded, ticks: () => tick };
}

describe("watchServe run errors after a restart", () => {
  const watch = (answers: Record<string, unknown>[], atRestart: Record<string, unknown> | null) => {
    const machine = answering(answers);
    return { machine, why: watchServe(machine.ports, { confirmed: answers[0]!, atRestart }, TARGET, DEFAULT_WATCH_WINDOW) };
  };

  it("does not roll back when held runs read recovery_required for two ticks after the restart and are then re-adopted", async () => {
    const { why } = watch([answer([]), answer(["p1", "p2", "p3"]), answer(["p1", "p2"]), answer([])], drained([]));

    expect(await why).toBeUndefined();
  });

  it("keeps the new build when the 6 runs busy at the restart still need recovery at the window's end", async () => {
    const { why } = watch([answer([]), answer(PARKED_IDS)], drained(PARKED_IDS));

    expect(await why).toBeUndefined();
  });

  it("rolls back when a run that was idle at the restart needs recovery at the window's end", async () => {
    const { why } = watch([answer([]), answer([...PARKED_IDS, "idle"])], drained(PARKED_IDS));

    expect(await why).toContain("1 more run(s) failed or need recovery during the 120 s watch");
  });

  it("rolls back when a run fails inside the window, even one the restart interrupted", async () => {
    const { why } = watch([answer([]), answer([], 226)], drained(PARKED_IDS));

    expect(await why).toContain("1 more run(s) failed or need recovery during the 120 s watch");
  });

  it("does not roll back on a run that reads recovery_required on the last tick alone", async () => {
    const answers = [...Array.from({ length: 11 }, () => answer([])), answer(["blip"])];

    expect(await watch(answers, drained([])).why).toBeUndefined();
  });

  it("excuses busy runs by id when the drained build counted parked runs without listing them", async () => {
    const counted = { ...drained(PARKED_IDS), runs: { failed: 225, recovery_required: 1 }, recoveryRequired: undefined };

    expect(await watch([answer(["old"]), answer(["old", ...PARKED_IDS])], counted).why).toBeUndefined();
    expect(await watch([answer(["old"]), answer(["old", "idle", ...PARKED_IDS])], counted).why).toContain("1 more run(s)");
  });

  it("judges against the confirmed answer when the drain read no answer before the restart", async () => {
    expect(await watch([answer(["p1"]), answer(["p1", "p2"])], null).why).toContain("1 more run(s)");
  });

  it("records the window's sha and end once as it opens, and probes until that end", async () => {
    const { machine, why } = watch([answer([])], drained([]));

    await why;

    expect(machine.recorded).toEqual([{ sha: TARGET, windowEnd: DEFAULT_WATCH_WINDOW.windowMs }]);
    expect(machine.ticks()).toBe(DEFAULT_WATCH_WINDOW.windowMs / DEFAULT_WATCH_WINDOW.intervalMs);
  });
});

/** Each tick consumes one step and the last repeats; "unavailable" is a rate-limited or header-less 403/422/429 read, "error" a real failure. */
function reading(steps: ("answer" | "unavailable" | "error" | "wrong-sha")[]) {
  let clock = 0;
  let tick = 0;
  const recorded: WatchIntent[] = [];
  const ports = {
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
    alive: (pid: number) => pid === PID,
    probe: async (timeoutMs: number) => {
      const step = steps[Math.min(tick, steps.length - 1)];
      if (timeoutMs === FAST_PROBE_TIMEOUT_MS) tick += 1;
      if (step === "unavailable") return UNAVAILABLE;
      if (step === "wrong-sha") return { ...baseline, build: { sha: "b".repeat(40) } };
      return step === "error" ? null : baseline;
    },
    record: (intent: WatchIntent) => void recorded.push({ ...intent }),
  };
  return { ports, recorded, ticks: () => tick, now: () => clock };
}

describe("watchServe when reads are unavailable (A17: a rate-limited probe never rolls back)", () => {
  const CAPPED: WatchWindow = { ...WINDOW, unavailableCapMs: 50_000 };

  it("does not roll back on unavailable reads, and restarts the window on fresh probes once reads return", async () => {
    const steps = ["answer", "unavailable", "unavailable", "unavailable", "answer"] as const;
    const machine = reading([...steps]);

    const why = await watchServe(machine.ports, settled, TARGET, CAPPED);

    expect(why).toBeUndefined();
    expect(machine.recorded).toHaveLength(2);
    expect(machine.recorded.map((intent) => intent.windowEnd)).toEqual([WINDOW.windowMs, 50_000 + WINDOW.windowMs]);
    expect(machine.now()).toBe(50_000 + WINDOW.windowMs);
  });

  it("does not count unavailable reads toward the miss limit", async () => {
    const machine = reading(["unavailable", "unavailable", "unavailable", "unavailable", "answer"]);

    expect(await watchServe(machine.ports, settled, TARGET, CAPPED)).toBeUndefined();
  });

  it("holds with an alarm at the cap, and does not roll back", async () => {
    const machine = reading(["answer", "unavailable"]);

    const why = await watchServe(machine.ports, settled, TARGET, CAPPED);

    expect(why).toEqual({ held: expect.stringContaining("unavailable") });
  });

  it("holds reads that flicker between unavailable and answered once the unavailable time adds up to the cap", async () => {
    const machine = reading(["unavailable", "unavailable", "answer", "answer", "unavailable", "unavailable", "answer", "answer"]);

    const why = await watchServe(machine.ports, settled, TARGET, { ...WINDOW, unavailableCapMs: 30_000 });

    expect(why).toEqual({ held: expect.stringContaining("unavailable") });
  });

  it("still rolls back on a real error: misses in a row", async () => {
    const machine = reading(["answer", "error"]);

    expect(await watchServe(machine.ports, settled, TARGET, CAPPED)).toContain("serve stopped answering /health (3 probes in a row)");
  });

  it("still rolls back on a wrong sha that follows unavailable reads", async () => {
    const machine = reading(["unavailable", "unavailable", "wrong-sha"]);

    expect(await watchServe(machine.ports, settled, TARGET, CAPPED)).toContain("not " + TARGET);
  });

  it("keeps TP-2846's per-tick liveness probe and its { sha, windowEnd } intent", async () => {
    const machine = reading(["answer"]);

    await watchServe(machine.ports, settled, TARGET, WINDOW);

    expect(machine.ticks()).toBe(WINDOW.windowMs / WINDOW.intervalMs);
    expect(machine.recorded).toEqual([{ sha: TARGET, windowEnd: WINDOW.windowMs }]);
  });
});
