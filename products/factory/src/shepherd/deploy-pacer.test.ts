import { describe, expect, it } from "vitest";
import type { DeployRecord } from "../deploy.js";
import type { WatchIntent } from "../deploy-watch-window.js";
import {
  DEPLOY_MAX_WAIT_MS,
  DEPLOY_NOW_LABEL,
  DEPLOY_QUIET_MS,
  DEPLOY_STALE_SPAWN_MS,
  DEPLOY_WANTED,
  DEPLOY_WATCH_GRACE_MS,
  noteWanted,
  paceDecision,
  pacerStatus,
  pacerTick,
  readWanted,
  withWaiting,
  writeWanted,
  type DeploySpawn,
  type DeployWanted,
  type GreenRead,
  type PacerMemo,
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
function pacer(options: { busy?: number; lastDeploy?: DeployRecord; runningHolds?: (sha: string) => boolean; express?: (sha: string) => boolean; green?: (sha: string) => GreenRead } = {}) {
  const store = memoryStore();
  const spawns: Array<[number, string]> = [];
  const logs: string[] = [];
  const waits: PacerMemo = {};
  const world = {
    now: 0,
    busy: options.busy ?? 0,
    paused: false,
    runningSha: RUNNING,
    lastDeploy: options.lastDeploy,
    deployWindow: undefined as WatchIntent | undefined,
    green: options.green ?? ((sha: string): GreenRead => ({ sha })),
  };
  const merge = (sha: string) => writeWanted(STATE, store, noteWanted(readWanted(STATE, store), sha, world.now));
  const record: DeploySpawn = (sha) => (spawns.push([world.now / MIN, sha]), { pid: 1 });
  const tick = (spawn: DeploySpawn = record) =>
    pacerTick({
      stateDir: STATE,
      store,
      now: () => world.now,
      runningSha: () => world.runningSha,
      ...(options.runningHolds && { runningHolds: options.runningHolds }),
      ...(options.express && { express: options.express }),
      green: (sha) => world.green(sha),
      lastDeploy: () => world.lastDeploy,
      deployWindow: () => world.deployWindow,
      busy: () => world.busy,
      paused: () => world.paused,
      spawn,
      log: (line) => void logs.push(line),
      waits,
    });
  const ticksUntil = (minute: number) => {
    while (world.now < minute * MIN) {
      world.now += MIN;
      tick();
    }
  };
  return { store, spawns, logs, waits, world, merge, tick, ticksUntil, wanted: () => readWanted(STATE, store) };
}

const wantedAt = (sha: string, firstMin: number, lastMin: number, extra: Partial<DeployWanted> = {}): DeployWanted => ({
  sha,
  firstAt: new Date(firstMin * MIN).toISOString(),
  lastAt: new Date(lastMin * MIN).toISOString(),
  ...extra,
});

interface DecideExtra {
  busy?: number;
  lastDeploy?: DeployRecord;
  deployWindow?: WatchIntent;
  runningSha?: string;
  runningHoldsWanted?: boolean;
  paused?: boolean;
  express?: boolean;
  green?: GreenRead;
  runningHoldsGreen?: boolean;
}

const decide = (wanted: DeployWanted | undefined, nowMin: number, extra: DecideExtra = {}) =>
  paceDecision({
    wanted,
    green: extra.green ?? { sha: wanted?.sha ?? "" },
    runningHoldsGreen: extra.runningHoldsGreen ?? false,
    now: nowMin * MIN,
    runningSha: extra.runningSha ?? RUNNING,
    runningHoldsWanted: extra.runningHoldsWanted ?? false,
    lastDeploy: extra.lastDeploy,
    deployWindow: extra.deployWindow,
    busy: extra.busy ?? 0,
    paused: extra.paused ?? false,
    express: extra.express ?? false,
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

  it("shas landing every 8 minutes deploy the newest at the 45-minute bound instead of starving behind the quiet window", () => {
    const p = pacer();
    for (let minute = 0; minute <= 96; minute += 8) {
      p.ticksUntil(minute);
      p.merge(`sha-${minute}`);
    }

    p.ticksUntil(100);

    expect(p.spawns[0]).toEqual([45, "sha-40"]);
  });

  it("busy runs hold the deploy until the cap", () => {
    const wanted = wantedAt("a", 0, 0);

    const held = decide(wanted, 30, { busy: 2 });
    const capped = decide(wanted, 45, { busy: 2 });

    expect(held).toEqual({ kind: "wait", why: "2 busy run(s)", until: 45 * MIN, key: "busy runs" });
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

  it("the next green merge replaces an ask whose deployer was refused and recorded nothing, and deploys after its own quiet window (TP-4085)", () => {
    const p = pacer();
    p.merge("a");
    p.ticksUntil(30);

    p.merge("b");
    p.ticksUntil(60);

    expect(p.wanted()).toMatchObject({ sha: "b", firstAt: new Date(30 * MIN).toISOString(), spawnedSha: "b" });
    expect(p.spawns).toEqual([[15, "a"], [45, "b"]]);
  });

  it("an older sha the queued one contains keeps the queued record, spawn mark and all", () => {
    const spawned = wantedAt("b", 0, 5, { spawnedSha: "b", spawnedAt: new Date(15 * MIN).toISOString() });

    expect(noteWanted(spawned, "a", 20 * MIN, "b")).toBe(spawned);
  });

  it("a containing sha that is no longer the queued one does not keep it", () => {
    const queued = wantedAt("c", 0, 0);

    expect(noteWanted(queued, "a", 5 * MIN, "b")).toEqual(wantedAt("a", 0, 5));
  });

  it("with no record, a containing sha still queues the incoming one", () => {
    expect(noteWanted(undefined, "a", 5 * MIN, "b")).toEqual(wantedAt("a", 5, 5));
  });

  it("steady merges while a spawned deploy is unserved spawn once per cap, not once per merge", () => {
    const p = pacer();
    for (let minute = 0; minute <= 240; minute += 5) {
      p.ticksUntil(minute);
      p.merge(`sha-${minute}`);
    }

    p.ticksUntil(240);

    expect(p.spawns.map(([minute]) => minute)).toEqual([45, 90, 135, 180, 225]);
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
    expect(pacerStatus(wantedAt("a", 0, 5))).toEqual({ sha: "a", since: new Date(0).toISOString(), deploysBy: new Date(45 * MIN).toISOString() });
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

/** The deployer spawned at minute 15 restarts serve on "b", which contains the asked "a", and opens a watch window to minute 18. */
function deployInWatch() {
  const contains = new Set<string>();
  const p = pacer({ runningHolds: (sha) => contains.has(sha), lastDeploy: { outcome: "deployed", target: RUNNING, from: "sha-older", at: new Date(-MIN).toISOString() } });
  p.merge("a");
  p.ticksUntil(15);
  p.world.runningSha = "b";
  contains.add("a");
  p.world.deployWindow = { sha: "b", windowEnd: 18 * MIN };
  return { p, contains };
}

/** At minute 17.5 the watch of "b" fails: serve is back on the old build, deploy.json records b rolled back, and deploys are paused. */
function rolledBackInWatch() {
  const world = deployInWatch();
  world.p.ticksUntil(17);
  world.p.world.runningSha = RUNNING;
  world.contains.clear();
  world.p.world.lastDeploy = { outcome: "rolled-back", target: "b", from: RUNNING, at: new Date(17.5 * MIN).toISOString() };
  world.p.world.paused = true;
  return world;
}

describe("the deploy pacer and the health watch of the deploy that contains the ask", () => {
  it("an ask survives a rollback inside the watch and is never re-asked as origin/main, whose CI nobody read (TP-4279)", () => {
    const { p } = rolledBackInWatch();
    p.ticksUntil(30);
    p.world.paused = false;

    const unpaused = p.tick();

    expect(p.spawns).toEqual([[15, "a"]]);
    expect(unpaused).toEqual({ kind: "wait", why: "deployer already started for a", until: 15 * MIN + DEPLOY_STALE_SPAWN_MS });
  });

  it("an ask is cleared once a later deploy lands a build that contains it and passes its watch", () => {
    const { p, contains } = rolledBackInWatch();
    p.ticksUntil(30);
    p.world.paused = false;
    p.ticksUntil(31);

    p.world.now = 40 * MIN;
    p.world.runningSha = "c";
    contains.add("a");
    p.world.deployWindow = { sha: "c", windowEnd: 39 * MIN };
    p.world.lastDeploy = { outcome: "deployed", target: "c", from: RUNNING, at: new Date(39 * MIN).toISOString() };

    expect(p.tick()).toEqual({ kind: "clear", why: "the service runs c, which contains a" });
  });

  it("a deployer that died in its watch holds the ask only until the grace after the window ends", () => {
    const window = { sha: "b", windowEnd: 18 * MIN };
    const extra = { runningSha: "b", runningHoldsWanted: true, deployWindow: window };
    const graceEnds = (18 * MIN + DEPLOY_WATCH_GRACE_MS) / MIN;

    const inGrace = decide(wantedAt("a", 0, 0), graceEnds - 1, extra);
    const past = decide(wantedAt("a", 0, 0), graceEnds, extra);

    expect(inGrace.kind).toBe("wait");
    expect(past).toEqual({ kind: "clear", why: "the service runs b, which contains a" });
  });

  it("an ask whose containing deploy passes its watch is cleared once deploy.json records it", () => {
    const { p } = deployInWatch();
    p.ticksUntil(17);
    const inWatch = p.wanted();

    p.world.now = 18 * MIN;
    p.world.lastDeploy = { outcome: "deployed", target: "b", from: RUNNING, at: new Date(18 * MIN).toISOString() };
    const settled = p.tick();

    expect(inWatch?.sha).toBe("a");
    expect(settled).toEqual({ kind: "clear", why: "the service runs b, which contains a" });
    expect(p.wanted()).toBeUndefined();
  });

  it("an ask is kept while the window for the running build is still open, even with its deploy recorded", () => {
    const window = { sha: "a", windowEnd: 18 * MIN };
    const record = { outcome: "deployed" as const, target: "a", from: RUNNING, at: new Date(17 * MIN).toISOString() };

    const open = decide(wantedAt("a", 0, 0), 17, { runningSha: "a", lastDeploy: record, deployWindow: window });
    const closed = decide(wantedAt("a", 0, 0), 18, { runningSha: "a", lastDeploy: record, deployWindow: window });

    expect(open.kind).toBe("wait");
    expect(closed).toEqual({ kind: "clear", why: "the service runs a" });
  });

  it("a running build that deploy.json records as rolled back does not answer the ask", () => {
    const record = { outcome: "rolled-back" as const, target: "b", from: RUNNING, at: new Date(17 * MIN).toISOString() };

    expect(decide(wantedAt("a", 0, 0), 20, { runningSha: "b", runningHoldsWanted: true, lastDeploy: record })).toEqual({ kind: "spawn", sha: "a" });
  });
});

describe("the deploy pacer and the ask's own main CI run (TP-4279)", () => {
  const ownRun = (status: string) => `the own CI run of tip is ${status}`;
  const fallbackTo = (green: string, status: string) => (sha: string): GreenRead => (sha === "tip" ? { sha: green, why: ownRun(status) } : { sha });

  it("never deploys an ask whose run is in progress after a failed parent while the service holds the last green, and deploys it once its run succeeds", () => {
    const run = { status: "in_progress" };
    const p = pacer({ runningHolds: (sha) => sha === "green", green: (sha) => (run.status === "success" ? { sha } : fallbackTo("green", run.status)(sha)) });
    p.merge("tip");
    p.ticksUntil(DEPLOY_MAX_WAIT_MS / MIN + 30);
    const whileRunning = [...p.spawns];

    run.status = "success";
    p.ticksUntil(DEPLOY_MAX_WAIT_MS / MIN + 31);

    expect(whileRunning).toEqual([]);
    expect(p.logs).toContain(`deploy pacer: waiting for tip: ${ownRun("in_progress")}; the service already holds green, the newest green sha`);
    expect(p.spawns).toEqual([[DEPLOY_MAX_WAIT_MS / MIN + 31, "tip"]]);
  });

  it("deploys the newest green sha in place of an ask whose run was cancelled, and does not ask again once deploy.json records it", () => {
    const p = pacer({ green: fallbackTo("green", "cancelled") });
    p.merge("tip");
    p.ticksUntil(15);
    p.world.lastDeploy = { outcome: "deployed", target: "green", from: RUNNING, at: new Date(16 * MIN).toISOString() };

    p.ticksUntil(15 + 2 * (DEPLOY_STALE_SPAWN_MS / MIN));

    expect(p.spawns).toEqual([[15, "green"]]);
    expect(p.logs).toContain(`deploy pacer: deployer pid 1 deploys green, the newest green sha, for tip (${ownRun("cancelled")})`);
    expect(p.wanted()).toMatchObject({ sha: "tip", spawnedSha: "green" });
  });

  it("holds the ask with no end, past the cap, when main CI cannot be read", () => {
    const p = pacer({ green: () => ({ why: "main's ci.yml runs could not be read" }) });
    p.merge("tip");

    p.ticksUntil(DEPLOY_MAX_WAIT_MS / MIN + 30);

    expect(p.spawns).toEqual([]);
    expect(p.waits.wait).toEqual({ sha: "tip", why: "no green sha to deploy: main's ci.yml runs could not be read", key: "no green sha to deploy: main's ci.yml runs could not be read" });
  });
});

describe(`the ${DEPLOY_NOW_LABEL} express lane`, () => {
  it("a labelled merge inside the quiet window spawns on the next tick and logs why", () => {
    const p = pacer({ express: (sha) => sha === "a" });
    p.merge("a");

    p.ticksUntil(1);

    expect(p.spawns).toEqual([[1, "a"]]);
    expect(p.logs).toContain(`deploy pacer: a carries ${DEPLOY_NOW_LABEL}; skipping the quiet window`);
  });

  it("an unlabelled merge after a labelled one is paced normally", () => {
    const p = pacer({ express: (sha) => sha === "a" });
    p.merge("a");
    p.ticksUntil(1);

    p.merge("b");
    p.ticksUntil(30);

    expect(p.spawns).toEqual([[1, "a"], [16, "b"]]);
  });

  it("a labelled merge with busy runs waits for them to drain, up to the cap", () => {
    const wanted = wantedAt("a", 0, 0);

    const held = decide(wanted, 1, { busy: 1, express: true });
    const drained = decide(wanted, 2, { busy: 0, express: true });

    expect(held).toEqual({ kind: "wait", why: "1 busy run(s)", until: DEPLOY_MAX_WAIT_MS, key: "busy runs" });
    expect(drained).toEqual({ kind: "spawn", sha: "a", express: true });
  });

  it("a labelled merge never spawns while deploys are paused", () => {
    expect(decide(wantedAt("a", 0, 0), 1, { paused: true, express: true }).kind).toBe("wait");
  });

  it("a labelled merge whose deployer already started is not spawned again", () => {
    const wanted = wantedAt("a", 0, 0, { spawnedSha: "a", spawnedAt: new Date(MIN).toISOString() });

    expect(decide(wanted, 2, { express: true })).toEqual({ kind: "wait", why: "deployer already started for a", until: MIN + DEPLOY_STALE_SPAWN_MS });
  });

  it("past the quiet window a labelled spawn is an ordinary one", () => {
    expect(decide(wantedAt("a", 0, 0), 20, { express: true })).toEqual({ kind: "spawn", sha: "a" });
  });
});

describe("the pacer's wait line (TP-2427)", () => {
  const at = (minute: number): string => new Date(minute * MIN).toISOString();
  const waiting = (sha: string, why: string, untilMin?: number): string => `deploy pacer: waiting for ${sha}: ${why}${untilMin === undefined ? "" : ` until ${at(untilMin)}`}`;

  it("a quiet-window wait is logged once across repeated sweeps", () => {
    const p = pacer();
    p.merge("a");

    p.ticksUntil(10);

    expect(p.logs).toEqual([waiting("a", "inside the quiet window", 15)]);
  });

  it("a change to a busy-run wait logs again, and a busy count that moves does not", () => {
    const p = pacer({ busy: 1 });
    p.merge("a");

    p.ticksUntil(20);
    p.world.busy = 2;
    p.ticksUntil(30);

    expect(p.logs).toEqual([waiting("a", "inside the quiet window", 15), waiting("a", "1 busy run(s)", 45)]);
    expect(p.spawns).toEqual([]);
    expect(p.waits.wait).toMatchObject({ sha: "a", why: "2 busy run(s)", until: at(45) });
  });

  it("idle logs nothing and keeps no wait", () => {
    const p = pacer();

    p.ticksUntil(5);

    expect(p.logs).toEqual([]);
    expect(p.waits.wait).toBeUndefined();
  });

  it("a new sha in the quiet window logs again", () => {
    const p = pacer();
    p.merge("a");
    p.ticksUntil(2);

    p.merge("b");
    p.ticksUntil(4);

    expect(p.logs).toEqual([waiting("a", "inside the quiet window", 15), waiting("b", "inside the quiet window", 17)]);
  });

  it("a paused wait logs no until-time, and a wait that ends forgets it", () => {
    const p = pacer();
    p.world.paused = true;
    p.merge("a");
    p.ticksUntil(3);

    p.world.runningSha = "a";
    p.ticksUntil(4);

    expect(p.logs).toEqual([waiting("a", "deploys are paused; titan-factory service pause --clear lifts it"), "deploy pacer: cleared a: the service runs a"]);
    expect(p.waits.wait).toBeUndefined();
  });

  it("withWaiting attaches the wait only for the same sha, without its change key", () => {
    const status = pacerStatus(wantedAt("a", 0, 5));

    expect(withWaiting(status, { sha: "b", why: "x", key: "x" })).toEqual(status);
    expect(withWaiting(status, { sha: "a", why: "1 busy run(s)", until: at(45), key: "busy runs" })).toEqual({ ...status, waiting: { why: "1 busy run(s)", until: at(45) } });
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
