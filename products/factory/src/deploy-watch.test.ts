import { describe, expect, it } from "vitest";
import type { MainLag } from "./deploy-health.js";
import { currentLag, deployWatch, type DeployWatchPorts } from "./deploy-watch.js";
import type { IndexLock } from "./stale-lock.js";

const SHA = "a".repeat(40);
const NEXT = "b".repeat(40);
const NOW = Date.parse("2026-10-07T12:00:00Z");
const LOCK = "/srv/checkout/.git/index.lock";
const REFUSAL = `2026-10-07T08:00:00Z service deploy --expect ${NEXT}\nerror: deploy refused: git merge --ff-only ${NEXT} failed: Unable to create '${LOCK}': File exists.\n`;

interface Fake {
  ports: DeployWatchPorts;
  sent: string[];
  log: string[];
  failNext: () => void;
}

function fake(lock: IndexLock = { state: "stale", path: LOCK, ageMs: 60 * 60_000 }, lag: MainLag = { behind: 1, oldestAt: NOW }): Fake {
  const sent: string[] = [];
  const log: string[] = [];
  let fail = false;
  const ports: DeployWatchPorts = {
    readLog: () => (log.length === 0 ? undefined : log.join("")),
    runningSha: () => SHA,
    lag: async () => lag,
    indexLock: async () => lock,
    notify: async (text) => {
      if (fail) {
        fail = false;
        throw new Error("no live session named hub");
      }
      sent.push(text);
    },
    now: () => NOW,
  };
  return { ports, sent, log, failNext: () => void (fail = true) };
}

describe("the deploy watch serve runs", () => {
  it("tells the hub seat once when two refusals raise the alarm, and not again while it stays up", async () => {
    const { ports, sent, log } = fake();
    const watch = deployWatch(ports);

    log.push(REFUSAL);
    await watch.tick();
    log.push(REFUSAL);
    await watch.tick();
    log.push(REFUSAL);
    await watch.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^titan-factory deploy alarm: service deploy refused 2 times in a row/);
    expect(watch.status()).toMatchObject({ alarm: true, consecutiveRefusals: 3, notice: { sent: "2026-10-07T12:00:00.000Z" } });
  });

  it("clears the alarm on a successful deploy, and tells the hub seat again when a new one goes up", async () => {
    const { ports, sent, log } = fake();
    const watch = deployWatch(ports);

    log.push(REFUSAL, REFUSAL);
    await watch.tick();
    log.push(`deployed ${NEXT}\n`);
    await watch.tick();
    const cleared = watch.status();
    log.push(REFUSAL, REFUSAL);
    await watch.tick();

    expect(cleared).toMatchObject({ alarm: false, consecutiveRefusals: 0, notice: null });
    expect(sent).toHaveLength(2);
  });

  it("names the stale index.lock by path and age in the refusal reason", async () => {
    const { ports, log } = fake();
    const watch = deployWatch(ports);

    log.push(REFUSAL);
    await watch.tick();

    expect(watch.status()?.lastRefusal?.reason).toContain(`stale ${LOCK}, 60 min old with no process holding it`);
  });

  it("retries a notice that failed on the next tick", async () => {
    const { ports, sent, log, failNext } = fake();
    const watch = deployWatch(ports);

    log.push(REFUSAL, REFUSAL);
    failNext();
    await watch.tick();
    const failed = watch.status()?.notice;
    await watch.tick();

    expect(failed).toEqual({ failed: "no live session named hub" });
    expect(sent).toHaveLength(1);
  });

  it("raises the alarm on lag alone, and reports no hub seat when none is configured", async () => {
    const { ports } = fake(undefined, { behind: 4, oldestAt: NOW });
    const watch = deployWatch({ ...ports, notify: undefined });

    await watch.tick();

    expect(watch.status()).toMatchObject({ alarm: true, behind: 4, consecutiveRefusals: 0, notice: { skipped: "no hub seat is configured" } });
  });

  it("raises no alarm when unrelated merges follow a skipped deploy that left the build behind", async () => {
    const lags: Record<string, MainLag> = { [SHA]: { behind: 5, oldestAt: NOW - 2 * 60 * 60_000 }, [NEXT]: { behind: 4, oldestAt: NOW - 90 * 60_000 } };
    const landed = "c".repeat(40);
    lags[landed] = { behind: 0 };
    const { ports, sent, log } = fake();
    const watch = deployWatch({ ...ports, lag: () => currentLag([SHA, landed], async (sha) => lags[sha]!) });

    log.push(`2026-10-07T10:00:00Z service deploy --expect ${landed}\nskipped ${landed}: no changed path reaches the factory build\n`);
    await watch.tick();

    expect(watch.status()).toMatchObject({ alarm: false, behind: 0, behindMinutes: 0, runningSha: SHA });
    expect(sent).toEqual([]);
  });

  it("still raises the lag alarm when no landed target is any closer than the build", async () => {
    const lag = await currentLag([SHA, undefined], async () => ({ behind: 4, oldestAt: NOW }));

    expect(lag).toEqual({ behind: 4, oldestAt: NOW });
  });

  it("takes the readable lag when one candidate cannot be compared, and the reason when none can", async () => {
    const mixed = await currentLag([SHA, NEXT], async (sha) => (sha === SHA ? "gh compare failed (1): HTTP 502" : { behind: 2 }));
    const none = await currentLag([SHA], async () => "gh compare failed (1): HTTP 502");

    expect([mixed, none]).toEqual([{ behind: 2 }, "gh compare failed (1): HTTP 502"]);
  });

  it("has no block before its first tick", () => {
    expect(deployWatch(fake().ports).status()).toBeNull();
  });
});
