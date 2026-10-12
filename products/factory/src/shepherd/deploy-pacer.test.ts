import { describe, expect, it } from "vitest";
import type { DeployRecord } from "../deploy.js";
import {
  DEPLOY_MAX_WAIT_MS,
  DEPLOY_QUIET_MS,
  DEPLOY_STALE_SPAWN_MS,
  DEPLOY_WANTED,
  noteWanted,
  paceDecision,
  pacerStatus,
  pacerTick,
  readWanted,
  writeWanted,
  type DeployWanted,
  type WantedStore,
} from "./deploy-pacer.js";

const MIN = 60_000;
const STATE = "/state";
const PATH = `${STATE}/${DEPLOY_WANTED}`;
const RUNNING = "sha-running";

function memoryStore(): WantedStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (path) => files.get(path),
    writeFile: (path, text) => void files.set(path, text),
    rename: (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    remove: (path) => void files.delete(path),
  };
}

/** A pacer over an in-memory state dir and a settable clock, recording every spawn as `[minute, sha]`. */
function pacer(options: { busy?: number; lastDeploy?: DeployRecord; runningHolds?: (sha: string) => boolean } = {}) {
  const store = memoryStore();
  const spawns: Array<[number, string]> = [];
  const logs: string[] = [];
  const world = { now: 0, busy: options.busy ?? 0, paused: false, runningSha: RUNNING, lastDeploy: options.lastDeploy };
  const merge = (sha: string) => writeWanted(STATE, store, noteWanted(readWanted(STATE, store), sha, world.now));
  const tick = (spawn = (sha: string) => (spawns.push([world.now / MIN, sha]), { pid: 1 })) =>
    pacerTick({
      stateDir: STATE,
      store,
      now: () => world.now,
      runningSha: () => world.runningSha,
      ...(options.runningHolds && { runningHolds: options.runningHolds }),
      lastDeploy: () => world.lastDeploy,
      busy: () => world.busy,
      paused: () => world.paused,
      spawn,
      log: (line) => void logs.push(line),
    });
  const ticksUntil = (minute: number) => {
    while (world.now < minute * MIN) {
      world.now += MIN;
      tick();
    }
  };
  return { store, spawns, logs, world, merge, tick, ticksUntil, wanted: () => readWanted(STATE, store) };
}

const wantedAt = (sha: string, firstMin: number, lastMin: number, extra: Partial<DeployWanted> = {}): DeployWanted => ({
  sha,
  firstAt: new Date(firstMin * MIN).toISOString(),
  lastAt: new Date(lastMin * MIN).toISOString(),
  ...extra,
});

const decide = (wanted: DeployWanted | undefined, nowMin: number, extra: { busy?: number; lastDeploy?: DeployRecord; runningSha?: string; paused?: boolean } = {}) =>
  paceDecision({
    wanted,
    now: nowMin * MIN,
    runningSha: extra.runningSha ?? RUNNING,
    lastDeploy: extra.lastDeploy,
    busy: extra.busy ?? 0,
    paused: extra.paused ?? false,
    quietMs: DEPLOY_QUIET_MS,
    maxWaitMs: DEPLOY_MAX_WAIT_MS,
    staleSpawnMs: DEPLOY_STALE_SPAWN_MS,
  });

describe("deploy pacer", () => {
  it("a burst of merges deploys once, for the newest sha, after the quiet window", () => {
    const p = pacer();
    for (const [minute, sha] of [[0, "a"], [3, "b"], [6, "c"], [9, "d"]] as const) {
      p.ticksUntil(minute);
      p.merge(sha);
    }

    p.ticksUntil(40);

    expect(p.spawns).toEqual([[24, "d"]]);
  });

  it("steady merges still deploy by the cap", () => {
    const p = pacer();
    for (let minute = 0; minute <= 100; minute += 10) {
      p.ticksUntil(minute);
      p.merge(`sha-${minute}`);
    }

    p.ticksUntil(110);

    expect(p.spawns[0]).toEqual([90, "sha-80"]);
  });

  it("busy runs hold the deploy until the cap", () => {
    const wanted = wantedAt("a", 0, 0);

    const held = decide(wanted, 30, { busy: 2 });
    const capped = decide(wanted, 90, { busy: 2 });

    expect(held).toEqual({ kind: "wait", why: "2 busy run(s)", until: 90 * MIN });
    expect(capped).toEqual({ kind: "spawn", sha: "a" });
  });

  it("one spawn per sha, and a new sha re-arms it after its own quiet window", () => {
    const p = pacer();
    p.merge("a");
    p.ticksUntil(25);

    p.world.now = 30 * MIN;
    p.merge("b");
    p.ticksUntil(60);

    expect(p.spawns).toEqual([[15, "a"], [45, "b"]]);
  });

  it("a served sha clears the record", () => {
    const p = pacer();
    p.merge("a");
    p.world.runningSha = "a";

    const decision = p.tick();

    expect(decision.kind).toBe("clear");
    expect(p.store.files.has(PATH)).toBe(false);
  });

  it("a running build that descends from the wanted sha clears the record, so the next merge starts a fresh window", () => {
    const p = pacer({ runningHolds: (sha) => sha === "a" });
    p.merge("a");
    p.world.now = 60 * MIN;

    const decision = p.tick();
    p.world.now = 61 * MIN;
    p.merge("b");

    expect(decision).toEqual({ kind: "clear", why: `the service runs ${RUNNING}, which contains a` });
    expect(p.wanted()?.firstAt).toBe(new Date(61 * MIN).toISOString());
  });

  it.each(["deployed", "skipped", "rolled-back"] as const)("a deploy.json record for the sha with outcome %s after the spawn clears it", (outcome) => {
    const wanted = wantedAt("a", 0, 0, { spawnedSha: "a", spawnedAt: new Date(15 * MIN).toISOString() });
    const record = { outcome, target: "a", from: RUNNING, at: new Date(16 * MIN).toISOString() };

    expect(decide(wanted, 17, { lastDeploy: record }).kind).toBe("clear");
  });

  it("a deploy.json record for the sha from before the spawn does not clear it", () => {
    const wanted = wantedAt("a", 0, 0, { spawnedSha: "a", spawnedAt: new Date(15 * MIN).toISOString() });
    const stale = { outcome: "rolled-back" as const, target: "a", from: RUNNING, at: new Date(14 * MIN).toISOString() };

    expect(decide(wanted, 17, { lastDeploy: stale })).toEqual({ kind: "wait", why: "deployer already started for a", until: 15 * MIN + DEPLOY_STALE_SPAWN_MS });
  });

  it("a step replay does not extend the wait", () => {
    const first = noteWanted(undefined, "a", 0);

    const replayed = noteWanted(first, "a", 10 * MIN);

    expect(replayed.lastAt).toBe(first.lastAt);
    expect(decide(replayed, 15)).toEqual({ kind: "spawn", sha: "a" });
  });

  it("a new sha after a spawn starts its own window and drops the spawn mark", () => {
    const spawned = wantedAt("a", 0, 0, { spawnedSha: "a", spawnedAt: new Date(15 * MIN).toISOString() });

    const next = noteWanted(spawned, "b", 20 * MIN);

    expect(next).toEqual(wantedAt("b", 20, 20));
  });

  it("steady merges while a spawned deploy is unserved spawn once per cap, not once per merge", () => {
    const p = pacer();
    for (let minute = 0; minute <= 240; minute += 5) {
      p.ticksUntil(minute);
      p.merge(`sha-${minute}`);
    }

    p.ticksUntil(240);

    expect(p.spawns.map(([minute]) => minute)).toEqual([90, 180]);
  });

  it("a wanted file with an unparseable time reads as none instead of spawning at once", () => {
    const p = pacer();
    p.store.files.set(PATH, JSON.stringify({ sha: "a", firstAt: "not a date", lastAt: new Date(0).toISOString() }));
    p.world.now = MIN;

    const decision = p.tick();

    expect(decision).toEqual({ kind: "idle" });
    expect(p.spawns).toEqual([]);
  });

  it("an unreadable wanted file that exists is logged and removed instead of idling silently", () => {
    const p = pacer();
    p.store.files.set(PATH, '{"sha":"a","firstAt":');

    p.tick();
    p.tick();

    expect(p.logs).toEqual([expect.stringMatching(/removed an unreadable deploy-wanted\.json/)]);
    expect(p.store.files.has(PATH)).toBe(false);
  });

  it("a wanted file that cannot be read at all is logged", () => {
    const p = pacer();
    p.store.readFile = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };

    const decision = p.tick();

    expect(decision).toEqual({ kind: "idle" });
    expect(p.logs).toEqual([expect.stringMatching(/removed an unreadable deploy-wanted\.json/)]);
  });

  it("a torn wanted file reads as none and is rewritten on the next request", () => {
    const p = pacer();
    p.store.files.set(PATH, '{"sha":"a","firstAt":');

    const torn = p.tick();
    p.merge("b");

    expect(torn).toEqual({ kind: "idle" });
    expect(p.wanted()).toEqual(wantedAt("b", 0, 0));
  });

  it("spawnedSha is written before spawn, so a spawn that throws leaves it set and logs", () => {
    const p = pacer();
    p.merge("a");
    p.world.now = 15 * MIN;

    const decision = p.tick(() => {
      throw new Error("spawn EAGAIN");
    });

    expect(decision.kind).toBe("wait");
    expect(p.wanted()?.spawnedSha).toBe("a");
    expect(p.logs.some((line) => line.includes("the pacer tick failed"))).toBe(true);
  });

  it("reports the wanted sha and its cap for /health, or null when none is wanted", () => {
    expect(pacerStatus(undefined)).toBeNull();
    expect(pacerStatus(wantedAt("a", 0, 5))).toEqual({ sha: "a", since: new Date(0).toISOString(), deploysBy: new Date(90 * MIN).toISOString() });
  });

  it("a paused deploy is never spawned, even past the cap, and spawns once the pause is cleared", () => {
    const p = pacer();
    p.merge("a");
    p.world.paused = true;
    p.ticksUntil(DEPLOY_MAX_WAIT_MS / MIN + 30);

    const pausedSpawns = [...p.spawns];
    p.world.paused = false;
    p.ticksUntil(DEPLOY_MAX_WAIT_MS / MIN + 31);

    expect(pausedSpawns).toEqual([]);
    expect(p.spawns).toEqual([[DEPLOY_MAX_WAIT_MS / MIN + 31, "a"]]);
  });

  it("a deployer that records nothing is asked once more after the stale timeout, then the sha is dropped", () => {
    const p = pacer();
    const stale = DEPLOY_STALE_SPAWN_MS / MIN;
    p.merge("a");

    p.ticksUntil(15 + 2 * stale + 1);

    expect(p.spawns).toEqual([[15, "a"], [15 + stale, "a"]]);
    expect(p.wanted()).toBeUndefined();
    expect(p.logs.filter((line) => line.includes("recorded nothing"))).toHaveLength(2);
  });
});

describe("the wanted record write", () => {
  it("writes a temp file beside the record and renames it over the record", () => {
    const store = memoryStore();
    const writes: string[] = [];
    const write = store.writeFile;
    store.writeFile = (path, text) => (writes.push(path), write(path, text));

    writeWanted(STATE, store, wantedAt("a", 0, 0));

    expect(writes).toEqual([`${PATH}.${process.pid}.tmp`]);
    expect([...store.files.keys()]).toEqual([PATH]);
    expect(readWanted(STATE, store)).toEqual(wantedAt("a", 0, 0));
  });

  it("a write that fails before the rename leaves the previous record whole", () => {
    const store = memoryStore();
    writeWanted(STATE, store, wantedAt("a", 0, 0));
    store.rename = () => {
      throw new Error("EXDEV");
    };

    expect(() => writeWanted(STATE, store, wantedAt("b", 1, 1))).toThrow("EXDEV");
    expect(readWanted(STATE, store)).toEqual(wantedAt("a", 0, 0));
  });
});
