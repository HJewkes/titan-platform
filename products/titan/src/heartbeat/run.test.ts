import type { TurnState } from "./turn-state.js";
import { describe, expect, it } from "vitest";
import { waitForIdleBeat, type IdleBeatPorts } from "./run.js";

const MIN = 60_000;
const POLL = MIN;

/** A session scripted minute by minute: `turns` lists the minutes at which a turn ends. */
interface Script {
  turns: number[];
  /** Minutes during which a turn is running. */
  busy?: number[];
  stop?: boolean;
  /** The minute the session exits. */
  exitsAt?: number;
}

function rig(script: Script): { ports: IdleBeatPorts; elapsedMin: () => number; stopChecks: () => number } {
  let now = 0;
  let stopChecks = 0;
  const minute = (): number => Math.floor(now / MIN);
  const readTurn = (): TurnState => {
    if (script.busy?.includes(minute())) return { kind: "busy" };
    const ended = script.turns.filter((m) => m <= minute()).at(-1);
    return ended === undefined ? { kind: "busy" } : { kind: "idle", sinceMs: ended * MIN };
  };
  const ports: IdleBeatPorts = {
    readTurn,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      if (now > 24 * 60 * MIN) throw new Error("never fired");
    },
    stopHolds: () => {
      stopChecks += 1;
      return script.stop === true;
    },
    sessionAlive: () => script.exitsAt === undefined || minute() < script.exitsAt,
  };
  return { ports, elapsedMin: minute, stopChecks: () => stopChecks };
}

describe("waitForIdleBeat", () => {
  it("fires once the session has been idle for the threshold since its last turn", async () => {
    const { ports, elapsedMin } = rig({ turns: [0] });

    const outcome = await waitForIdleBeat({ idleMs: 20 * MIN }, POLL, ports);

    expect(outcome).toEqual({ kind: "beat", reason: "idle", idleMs: 20 * MIN });
    expect(elapsedMin()).toBe(20);
  });

  it("does not fire while turns keep happening inside the threshold", async () => {
    const turns = Array.from({ length: 12 }, (_, i) => i * 10);
    const { ports, elapsedMin } = rig({ turns });

    await waitForIdleBeat({ idleMs: 20 * MIN }, POLL, ports);

    expect(elapsedMin()).toBe(130);
  });

  it("resets the idle clock on a new turn", async () => {
    const { ports, elapsedMin } = rig({ turns: [0, 15] });

    const outcome = await waitForIdleBeat({ idleMs: 20 * MIN }, POLL, ports);

    expect(elapsedMin()).toBe(35);
    expect(outcome).toMatchObject({ kind: "beat", reason: "idle" });
  });

  it("never fires mid-turn, even long past the threshold", async () => {
    const busy = Array.from({ length: 50 }, (_, i) => i + 10);
    const { ports, elapsedMin } = rig({ turns: [0, 60], busy });

    await waitForIdleBeat({ idleMs: 20 * MIN }, POLL, ports);

    expect(elapsedMin()).toBe(80);
  });

  it("fires at the max interval between turns of a session that never idles that long", async () => {
    const turns = Array.from({ length: 12 }, (_, i) => i * 10);
    const { ports, elapsedMin } = rig({ turns });

    const outcome = await waitForIdleBeat({ idleMs: 20 * MIN, maxMs: 45 * MIN }, POLL, ports);

    expect(outcome).toEqual({ kind: "beat", reason: "max", idleMs: 5 * MIN });
    expect(elapsedMin()).toBe(45);
  });

  it("stops instead of beating when the stop condition holds", async () => {
    const { ports, stopChecks } = rig({ turns: [0], stop: true });

    const outcome = await waitForIdleBeat({ idleMs: 20 * MIN }, POLL, ports);

    expect(outcome).toEqual({ kind: "stopped" });
    expect(stopChecks()).toBe(1);
  });

  it("checks the stop condition only when a beat is due", async () => {
    const { ports, stopChecks } = rig({ turns: [0] });

    await waitForIdleBeat({ idleMs: 20 * MIN }, POLL, ports);

    expect(stopChecks()).toBe(1);
  });

  it("ends quietly once the session that armed it has exited", async () => {
    const { ports } = rig({ turns: [0], exitsAt: 5 });

    expect(await waitForIdleBeat({ idleMs: 20 * MIN }, POLL, ports)).toEqual({ kind: "session-gone" });
  });
});
