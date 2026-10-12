import { describe, expect, it } from "vitest";
import { fencedRestart, KILL_SETTLE_MS, STOP_FENCE_MS, type RestartFencePorts } from "./restart-fence.js";

const OLD = 100;
const NEW = 101;

interface FakeUnit {
  /** ms after the restart request at which the old main exits on its own; absent means it ignores SIGTERM. */
  stopsAfterMs?: number;
  /** The SIGKILL leaves the old main in place. */
  killIgnored?: boolean;
  /** Each MainPID read costs this much wall time, as a slow `systemctl show` does. */
  readCostMs?: number;
}

/** A unit whose MainPID moves to NEW once its old main is gone, on a clock that only sleep and reads advance. */
function fakeUnit(init: FakeUnit = {}) {
  let clock = 0;
  let requestedAt: number | undefined;
  let killedAt: number | undefined;
  const kills: number[] = [];
  const lines: string[] = [];
  const oldGone = (): boolean =>
    requestedAt !== undefined && ((init.stopsAfterMs !== undefined && clock >= requestedAt + init.stopsAfterMs) || (killedAt !== undefined && !init.killIgnored));
  const ports: RestartFencePorts = {
    readMainPid: async () => {
      clock += init.readCostMs ?? 0;
      return oldGone() ? NEW : OLD;
    },
    requestRestart: async () => {
      requestedAt = clock;
      return undefined;
    },
    killUnit: async () => {
      killedAt = clock;
      kills.push(clock);
      return undefined;
    },
    killVia: "systemctl kill",
    unit: "titan-factory.service",
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    log: (line) => void lines.push(line),
  };
  return { ports, kills, lines };
}

describe("fencedRestart", () => {
  it("returns the new MainPID without a kill when the old main stops on SIGTERM", async () => {
    const unit = fakeUnit({ stopsAfterMs: 3_000 });

    const outcome = await fencedRestart(unit.ports);

    expect(outcome).toEqual({ ok: true, pid: NEW });
    expect(unit.kills).toEqual([]);
    expect(unit.lines).toEqual([]);
  });

  it("SIGKILLs the unit once, at 45 s, when the old main ignores SIGTERM, and logs the fenced pid", async () => {
    const unit = fakeUnit();

    const outcome = await fencedRestart(unit.ports);

    expect(outcome).toEqual({ ok: true, pid: NEW, fenced: OLD });
    expect(unit.kills).toEqual([STOP_FENCE_MS]);
    expect(unit.lines).toEqual([`fenced pid ${OLD} (titan-factory.service MainPID, alive 45 s after SIGTERM): SIGKILL via systemctl kill\n`]);
  });

  it("escalates on the clock, not on a poll count, when each read is slow", async () => {
    const unit = fakeUnit({ readCostMs: 1_000 });

    await fencedRestart(unit.ports);

    expect(unit.kills).toHaveLength(1);
    expect(unit.kills[0]).toBeGreaterThanOrEqual(STOP_FENCE_MS);
    expect(unit.kills[0]).toBeLessThan(STOP_FENCE_MS + 5_000);
  });

  it("fails naming the pid and 55 s when the SIGKILL does not settle, and never hangs", async () => {
    const unit = fakeUnit({ killIgnored: true });

    const outcome = await fencedRestart(unit.ports);

    expect(outcome).toEqual({ ok: false, why: `pid ${OLD} is still titan-factory.service's main process 55 s after the restart, SIGKILL included` });
    expect(unit.kills).toHaveLength(1);
    expect(STOP_FENCE_MS + KILL_SETTLE_MS).toBe(55_000);
  });

  it("returns the refusal and kills nothing when the restart cannot be queued", async () => {
    const unit = fakeUnit();
    unit.ports.requestRestart = async () => "systemctl restart failed: Unit titan-factory.service not found.";

    const outcome = await fencedRestart(unit.ports);

    expect(outcome).toEqual({ ok: false, why: "systemctl restart failed: Unit titan-factory.service not found." });
    expect(unit.kills).toEqual([]);
  });

  it("fails without a kill when the unit has no main process at the deadline", async () => {
    const unit = fakeUnit();
    unit.ports.readMainPid = async () => undefined;

    const outcome = await fencedRestart(unit.ports);

    expect(outcome).toEqual({ ok: false, why: "titan-factory.service started no main process within 45 s" });
    expect(unit.kills).toEqual([]);
  });
});
