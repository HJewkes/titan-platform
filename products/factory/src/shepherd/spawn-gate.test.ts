import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolateAgentChatHome } from "../test-support/agent-chat-home.js";
import { agentChatAgents } from "./agents.js";
import { fixersOver } from "./main-red.js";
import { DEFAULT_HOLD_WAIT_MS } from "./review-wait.js";
import { agentChatReviewerDispatch } from "./reviewer-dispatch.js";
import type { RosterReader } from "./roster.js";
import { movedPastOnList, spawnQueuePosition, type ReviewAsk } from "./review-queue.js";
import { admitSpawn, DEFAULT_SPAWN_LIMITS, spawnGate, SpawnDeferred, type CheckoutDisk, type MachineReadings, type SpawnLimits } from "./spawn-gate.js";
import { implementersOver } from "./wake.js";
import { partialFake } from "@titan-design/test-kit";

/** A configured cost of four cores per unabsorbed review, which the accounting below reads; the measured default is in measured-load.test.ts. */
const limits: SpawnLimits = { ...DEFAULT_SPAWN_LIMITS, reviewLoad: 4 };
/** The pace windows the gate shipped with before load became the only limiter; a config can still set them. */
const paced: SpawnLimits = { ...limits, windowMs: 60_000, headroomIntervalMs: 15_000 };
/** One poll round: a review admitted this long ago is in load5, so it no longer counts as unabsorbed or takes a slot. */
const ROUND_MS = 5 * 60_000;
const idle: MachineReadings = { load5: 2, pressureLevel: 1, freeMemoryPct: 85 };
const GIB = 1024 ** 3;

describe("admitSpawn", () => {
  it("admits an idle machine with no earlier start", () => {
    expect(admitSpawn(idle, limits, [], 1_000)).toEqual({ admit: true });
  });

  it.each([
    ["load5 above the dispatch limit", { ...idle, load5: 29 }, []],
    ["load5 above the build limit", { ...idle, load5: 21 }, []],
    ["a just-started review pushing load5 past the build limit", { ...idle, load5: 17 }, [1_000]],
    ["memory pressure at the warn level", { ...idle, pressureLevel: 2 }, []],
    ["free memory under 20 percent", { ...idle, freeMemoryPct: 19 }, []],
  ])("refuses on %s", (_name, readings, running) => {
    expect(admitSpawn(readings, limits, [], 1_000, running).admit).toBe(false);
  });

  it("admits a fourth review at load5 10 when three started over five minutes ago", () => {
    const started = [1_000_000 - 600_001, 1_000_000 - 700_000, 1_000_000 - 900_000];
    expect(admitSpawn({ ...idle, load5: 10 }, limits, [], 1_000_000, started)).toEqual({ admit: true });
  });

  it("refuses a fourth review at load5 10 when three started under five minutes ago", () => {
    const started = [1_000_000 - 60_000, 1_000_000 - 120_000, 1_000_000 - 299_999];
    expect(admitSpawn({ ...idle, load5: 10 }, limits, [], 1_000_000, started).admit).toBe(false);
  });

  it("admits at the limits themselves", () => {
    expect(admitSpawn({ load5: 20, pressureLevel: 1, freeMemoryPct: 20 }, limits, [], 1_000).admit).toBe(true);
  });

  it("admits a second start in the same millisecond with the default pace windows at 0", () => {
    const busy = { ...idle, load5: limits.buildLoad5 / 2 };
    expect(admitSpawn(busy, limits, [10_000], 10_000)).toEqual({ admit: true });
    expect(admitSpawn(idle, limits, [10_000], 10_000)).toEqual({ admit: true });
  });

  it("refuses a second start inside a configured window and admits it after when load5 is at half of buildLoad5", () => {
    const busy = { ...idle, load5: paced.buildLoad5 / 2 };
    expect(admitSpawn(busy, paced, [10_000], 10_000 + paced.windowMs - 1)).toEqual({ admit: false, reason: "another spawn was admitted 59999 ms ago, inside the 60000 ms window" });
    expect(admitSpawn(busy, paced, [10_000], 10_000 + paced.windowMs).admit).toBe(true);
  });

  it("admits a second start after a configured headroom interval on a machine with headroom", () => {
    expect(admitSpawn(idle, paced, [10_000], 10_000 + paced.headroomIntervalMs - 1)).toEqual({ admit: false, reason: "another spawn was admitted 14999 ms ago, inside the 15000 ms headroom interval" });
    expect(admitSpawn(idle, paced, [10_000], 10_000 + paced.headroomIntervalMs)).toEqual({ admit: true });
  });

  it.each([
    ["load5 at half of buildLoad5", { ...idle, load5: 10 }, []],
    ["memory pressure unread", { load5: 2, freeMemoryPct: 85 }, []],
    ["unabsorbed reviews at their headroom cap", idle, [1_000, 2_000, 3_000, 4_000]],
  ])("keeps a configured 60 s window with %s", (_name, readings, running) => {
    const now = 100_000;
    expect(admitSpawn(readings, paced, [now - paced.headroomIntervalMs], now, running).admit).toBe(false);
    expect(admitSpawn(readings, paced, [now - paced.windowMs], now, running).admit).toBe(true);
  });

  it("still refuses on the unabsorbed-review accounting with headroom on load5", () => {
    const running = [1_000, 2_000, 3_000, 4_000, 5_000];
    expect(admitSpawn(idle, limits, [], 10_000, running)).toEqual({ admit: false, reason: "load5 with 5 unabsorbed reviews 22 is past the limit 20" });
  });
});

describe("spawnGate", () => {
  const scene = (readings: MachineReadings) => {
    const state = { readings, now: 1_000, lines: [] as string[] };
    const gate = spawnGate({ read: () => state.readings, now: () => state.now, log: (line) => void state.lines.push(line) });
    return { state, gate };
  };

  it("defers a spawn at a load5 above the limit and logs the deferral with the reading and the limit", () => {
    const { gate, state } = scene({ ...idle, load5: 40 });

    expect(() => gate.admit("rv-octo-demo-7")).toThrow(SpawnDeferred);
    expect(state.lines).toEqual(["shepherd: spawn_gate deferred rv-octo-demo-7: load5 40 is past the limit 28 (load5 40, pressure 1, free 85%)"]);
  });

  it("admits a spawn below the limit and logs the admission", () => {
    const { gate, state } = scene(idle);

    gate.admit("rv-octo-demo-7");

    expect(state.lines).toEqual(["shepherd: spawn_gate admitted rv-octo-demo-7 (load5 2, pressure 1, free 85%)"]);
  });

  it("admits a burst of four ready spawns in one poll with the default pace windows at 0", () => {
    const { gate } = scene(idle);
    const names = ["fx-a-1", "fx-b-2", "fx-c-3", "fx-d-4"];
    const admitted: string[] = [];

    names.forEach((name) => { try { gate.admit(name); admitted.push(name); } catch { /* deferred */ } });

    expect(admitted).toEqual(names);
  });

  it("admits a spawn every configured headroom interval on an idle machine", () => {
    const state = { now: 1_000 };
    const gate = spawnGate({ limits: { headroomIntervalMs: 10_000 }, read: () => idle, now: () => state.now, log: () => undefined });
    const admittedAt: number[] = [];
    for (; state.now <= 31_000; state.now += 5_000) {
      try { gate.admit(`fx-${state.now}`); admittedAt.push(state.now); } catch { /* deferred */ }
    }

    expect(admittedAt).toEqual([1_000, 11_000, 21_000, 31_000]);
  });

  it("admits a burst of ordinary reviews in one poll while the free slots last", () => {
    const { gate } = scene(idle);
    const names = ["rv-a-1", "rv-b-2", "rv-c-3", "rv-d-4"];
    const admitted: string[] = [];

    names.forEach((name) => { try { gate.admit(name, [], { fixer: false }); admitted.push(name); } catch { /* deferred */ } });

    expect(admitted).toEqual(["rv-a-1", "rv-b-2", "rv-c-3"]);
  });
});

describe("spawnGate tells the machine-stop ledger", () => {
  const scene = (readings: MachineReadings) => {
    const state = { now: 1_000, stops: [] as [number, string][] };
    const gate = spawnGate({ limits: paced, read: () => readings, now: () => state.now, log: () => undefined, onStop: (at, reason) => void state.stops.push([at, reason]) });
    return { state, gate };
  };

  it("notes a load5 past the machine stop even though the spawn is deferred", () => {
    const { gate, state } = scene({ ...idle, load5: 40 });

    expect(() => gate.admit("rv-octo-demo-7")).toThrow(SpawnDeferred);
    expect(state.stops).toEqual([[1_000, "load5 40 (limit 28)"]]);
  });

  it("notes memory pressure at the stop level", () => {
    const { gate, state } = scene({ ...idle, pressureLevel: 2 });

    expect(() => gate.admit("rv-octo-demo-7")).toThrow(SpawnDeferred);
    expect(state.stops).toEqual([[1_000, "memory pressure level 2 (limit 2)"]]);
  });

  it("notes nothing for a deferral on pace alone", () => {
    const { gate, state } = scene({ ...idle, load5: 1 });

    gate.admit("rv-a-1");
    expect(() => gate.admit("rv-b-2")).toThrow(SpawnDeferred);
    expect(state.stops).toEqual([]);
  });

  it("notes nothing for a deferral past the build limit but under the machine stop", () => {
    const { gate, state } = scene({ ...idle, load5: 21 });

    expect(() => gate.admit("rv-octo-demo-7")).toThrow(SpawnDeferred);
    expect(state.stops).toEqual([]);
  });
});

describe("spawnGate's review queue under a burst", () => {
  beforeEach(() => void vi.useFakeTimers({ now: 0 }));
  afterEach(() => void vi.useRealTimers());

  /** Queues one review per arrival on the faked clock; each resolves "started" or "gave up". */
  async function drain(startTimes: readonly number[], readings: MachineReadings): Promise<string[]> {
    const gate = spawnGate({ limits: { ...paced, maxConcurrentReviews: 64, reviewLoad: 0 }, read: () => readings, log: () => undefined });
    const start = { running: async () => [], launch: async () => undefined };
    const outcomes = startTimes.map(async (at, index) => {
      await new Promise((arrived) => setTimeout(arrived, at));
      return gate.queueReview(`rv-${index}`, { fixer: false }, start).then(() => "started", () => "gave up");
    });
    await vi.advanceTimersByTimeAsync(Math.max(...startTimes) + DEFAULT_HOLD_WAIT_MS);
    return Promise.all(outcomes);
  }

  /** Arrival times from a fixed-seed Lehmer generator, so a burst clumps the way real ready reviews do and every run is the same. */
  const arrivals = (count: number, overMs: number) => {
    let seed = 7_919;
    return Array.from({ length: count }, () => (seed = (seed * 48_271) % 2_147_483_647) % overMs);
  };

  it.each([
    ["24 reviews inside two minutes on an idle machine", arrivals(24, 120_000), idle],
    ["16 reviews inside two minutes at load5 12, under a configured one-a-minute window", arrivals(16, 120_000), { ...idle, load5: 12 }],
    ["60 reviews over an hour at load5 12", arrivals(60, 3_600_000), { ...idle, load5: 12 }],
  ])("starts every one of %s, none outwaiting the hold", async (_name, startTimes, readings) => {
    const outcomes = await drain(startTimes, readings);

    expect(outcomes.filter((outcome) => outcome !== "started")).toEqual([]);
  });
});

describe("spawnGate review priority", () => {
  const ordinary: ReviewAsk = { fixer: false };
  const fixer: ReviewAsk = { fixer: true };
  const scene = () => {
    const state = { readings: { ...idle, load5: 21 }, now: 1_000, lines: [] as string[] };
    const gate = spawnGate({ limits: { maxConcurrentReviews: 1 }, read: () => state.readings, now: () => state.now, log: (line) => void state.lines.push(line) });
    const ask = (name: string, review: ReviewAsk) => { try { gate.admit(name, [], review); return true; } catch { return false; } };
    return { state, gate, ask };
  };

  it("admits the waiting review of a red main's fix first once buildLoad5 clears, then the others in first-ask order", () => {
    const { state, ask } = scene();
    const waiting: [string, ReviewAsk][] = [["rv-a-1", ordinary], ["rv-b-2", ordinary], ["rv-fix-3", fixer]];
    const admitted: string[] = [];
    const poll = () => waiting.filter(([name]) => !admitted.includes(name)).forEach(([name, review]) => ask(name, review) && admitted.push(name));

    poll();
    expect(admitted).toEqual([]);
    state.readings = idle;
    for (let round = 0; round < 3; round++, state.now += ROUND_MS) poll();

    expect(admitted).toEqual(["rv-fix-3", "rv-a-1", "rv-b-2"]);
  });

  it("refuses an ordinary review with a reason naming the waiting fix review", () => {
    const { state, gate, ask } = scene();
    ask("rv-fix-3", fixer);
    state.readings = idle;

    expect(() => gate.admit("rv-a-1", [], ordinary)).toThrow("the review rv-fix-3 of a red main's fix waits ahead");
  });

  it("never holds back a spawn that is no review", () => {
    const { state, gate, ask } = scene();
    ask("rv-fix-3", fixer);
    state.readings = idle;

    gate.admit("fx-demo-abc");

    expect(state.lines.at(-1)).toBe("shepherd: spawn_gate admitted fx-demo-abc (load5 2, pressure 1, free 85%)");
  });
});

describe("every factory-started agent passes the one gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "titan-spawn-gate-"));
    isolateAgentChatHome(dir, ["rv"]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const bin = () => {
    const path = join(dir, "agent-chat");
    writeFileSync(path, `#!/bin/sh\n: >"${dir}/ran"\nexit 0\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const ran = () => existsSync(join(dir, "ran"));
  const roster: RosterReader = { read: async () => Object.assign(partialFake<Awaited<ReturnType<RosterReader["read"]>>>(), { known: true, rows: [] }), rows: async () => [], invalidate: () => undefined };
  const overloaded = () => spawnGate({ read: () => ({ ...idle, load5: 40 }), log: () => undefined });

  it("queues a reviewer spawn on an overloaded machine, starting nobody and showing its place", async () => {
    mkdirSync(join(dir, "co"));
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), roles: { g10: "rv", standard: "rv" }, cwdFor: () => join(dir, "co"), roster, gate: overloaded() });

    void dispatch.spawn("rv-octo-demo-17", "brief", { repo: "octo/demo", pr: 17, head: "a".repeat(40) });
    await vi.waitFor(() => expect(spawnQueuePosition("octo/demo", 17)).toBe("position 1 of 1"));

    expect(ran()).toBe(false);
  });

  it("defers a fixer spawn and starts nobody", async () => {
    const fixers = fixersOver(agentChatAgents(bin(), { roster, gate: overloaded() }));

    await expect(fixers.spawn("fx-demo-abc", "brief", dir)).rejects.toBeInstanceOf(SpawnDeferred);
    expect(ran()).toBe(false);
  });

  it("defers a successor spawn and starts nobody", async () => {
    const implementers = implementersOver(agentChatAgents(bin(), { roster, gate: overloaded() }));

    await expect(implementers.spawn("impl-b", "brief", dir)).rejects.toBeInstanceOf(SpawnDeferred);
    expect(ran()).toBe(false);
  });

  it("defers the resume of an exited agent and starts nobody", async () => {
    await expect(agentChatAgents(bin(), { roster, gate: overloaded() }).resume("impl-a", "wake")).rejects.toBeInstanceOf(SpawnDeferred);
    expect(ran()).toBe(false);
  });

  it("spawns the reviewer of a frozen repo's fix PR before two reviewers queued earlier, then the others oldest first", async () => {
    mkdirSync(join(dir, "co"));
    const state = { load5: 21, now: 0, admitted: [] as string[], lines: [] as string[] };
    const log = (line: string) => void (state.lines.push(line), line.startsWith("shepherd: spawn_gate admitted ") && state.admitted.push(line.split(" ")[3] ?? ""));
    const gate = spawnGate({ limits: { maxConcurrentReviews: 1 }, read: () => ({ ...idle, load5: state.load5 }), now: () => state.now, log });
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), roles: { g10: "rv", standard: "rv" }, cwdFor: () => join(dir, "co"), roster, gate, isFixer: ({ pr }) => pr === 9 });
    const started = [7, 8, 9].map((pr) => dispatch.spawn(`rv-octo-demo-${pr}`, "brief", { repo: "octo/demo", pr, head: "a".repeat(40) }, { intentAt: pr }));
    await vi.waitFor(() => expect(state.lines.some((line) => line.startsWith("shepherd: spawn_gate deferred rv-octo-demo-9"))).toBe(true));

    state.load5 = 3;
    for (let round = 1; round <= 3; round++, state.now += ROUND_MS) {
      gate.reviewEnded();
      await vi.waitFor(() => expect(state.admitted).toHaveLength(round));
    }
    await Promise.all(started);

    expect(state.admitted).toEqual(["rv-octo-demo-9", "rv-octo-demo-7", "rv-octo-demo-8"]);
  });

  it("keeps a queued resume of a reviewer first spawned at an older head when another review asks after its PR moved on", async () => {
    mkdirSync(join(dir, "co"));
    const state = { load5: 2, now: 100_000, lines: [] as string[], list: { at: 0, prs: [{ number: 7, headSha: "a".repeat(40) }] } };
    const gate = spawnGate({ limits: { maxConcurrentReviews: 1 }, read: () => ({ ...idle, load5: state.load5 }), now: () => state.now, log: (line) => void state.lines.push(line), movedPast: movedPastOnList(() => state.list) });
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), roles: { g10: "rv", standard: "rv" }, cwdFor: () => join(dir, "co"), roster, gate });
    await dispatch.spawn("rv-octo-demo-7", "brief", { repo: "octo/demo", pr: 7, head: "a".repeat(40) });
    state.load5 = 40;
    state.now += ROUND_MS;
    void dispatch.resume("rv-octo-demo-7", "review the fix").catch(() => undefined);
    await vi.waitFor(() => expect(spawnQueuePosition("octo/demo", 7)).toBe("position 1 of 1"));

    state.list = { at: state.now + 1, prs: [{ number: 7, headSha: "b".repeat(40) }, { number: 8, headSha: "a".repeat(40) }] };
    state.now += 2;
    void dispatch.spawn("rv-octo-demo-8", "brief", { repo: "octo/demo", pr: 8, head: "a".repeat(40) }).catch(() => undefined);
    await vi.waitFor(() => expect(spawnQueuePosition("octo/demo", 8)).toBe("position 2 of 2"));

    expect(state.lines.filter((line) => line.includes("dropped"))).toEqual([]);
    expect(spawnQueuePosition("octo/demo", 7)).toBe("position 1 of 2");
  });
});

describe("spawnGate admits deferred reviews oldest intent first", () => {
  const intent = (intentAt: number): ReviewAsk => ({ fixer: false, intentAt });
  const scene = () => {
    const state = { readings: { ...idle, load5: 21 }, now: 100_000, lines: [] as string[] };
    const gate = spawnGate({ limits: { maxConcurrentReviews: 1 }, read: () => state.readings, now: () => state.now, log: (line) => void state.lines.push(line) });
    const ask = (name: string, review: ReviewAsk) => { try { gate.admit(name, [], review); return true; } catch { return false; } };
    return { state, ask };
  };

  it("admits two deferred intents and a newer arrival oldest-first, whichever polls first", () => {
    const { state, ask } = scene();
    const older = ["rv-old-1", intent(10_000)] as const;
    const middle = ["rv-mid-2", intent(20_000)] as const;
    const newer = ["rv-new-3", intent(90_000)] as const;
    const admitted: string[] = [];
    const poll = (order: readonly (readonly [string, ReviewAsk])[]) => order.filter(([name]) => !admitted.includes(name)).forEach(([name, review]) => ask(name, review) && admitted.push(name));

    poll([older, middle]);
    state.readings = idle;
    for (let round = 0; round < 3; round++, state.now += ROUND_MS) poll([newer, middle, older]);

    expect(admitted).toEqual(["rv-old-1", "rv-mid-2", "rv-new-3"]);
  });

  it("refuses a newer intent while an older one waits, naming it", () => {
    const { state, ask } = scene();
    ask("rv-old-1", intent(10_000));
    state.readings = idle;

    expect(ask("rv-new-2", intent(50_000))).toBe(false);
    expect(ask("rv-old-1", intent(10_000))).toBe(true);
  });

  it("orders by the recorded intent time, not by who asked the gate first", () => {
    const { state, ask } = scene();
    ask("rv-new-2", intent(50_000));
    ask("rv-old-1", intent(10_000));
    state.readings = idle;

    expect(ask("rv-new-2", intent(50_000))).toBe(false);
  });

  it("logs the queue position and the oldest intent on each deferral", () => {
    const { state, ask } = scene();
    ask("rv-old-1", intent(10_000));
    ask("rv-new-2", intent(50_000));

    expect(state.lines.at(-1)).toContain("shepherd: spawn_gate deferred rv-new-2:");
    expect(state.lines.at(-1)).toContain("deferred: queue position 2 of 2 (oldest intent rv-old-1 since 1970-01-01T00:00:10.000Z)");
  });
});

describe("spawnGate holds reviews to the checkout filesystem's room and the concurrent-review cap", () => {
  const roomy: CheckoutDisk = { freeBytes: 50 * GIB, freeInodes: 800_000, totalInodes: 1_000_000, lastCheckoutInodes: 3_000 };
  const scene = (disk: CheckoutDisk, running: readonly number[] = [], caps: Partial<SpawnLimits> = {}) => {
    const state = { disk, running, now: 100_000, lines: [] as string[] };
    const gate = spawnGate({ limits: caps, read: () => idle, disk: () => state.disk, now: () => state.now, log: (line) => void state.lines.push(line) });
    const ask = (name: string, review: ReviewAsk = { fixer: false }) => { try { gate.admit(name, state.running, review); return true; } catch { return false; } };
    return { state, gate, ask };
  };

  it.each([
    ["free inodes under 15 percent of the filesystem", { ...roomy, freeInodes: 149_999 }, "free inodes 149999 is past the limit 150000"],
    ["free inodes under twice the last checkout", { ...roomy, freeInodes: 185_999, lastCheckoutInodes: 93_000 }, "free inodes 185999 is past the limit 186000"],
    ["free bytes under the floor", { ...roomy, freeBytes: 5 * GIB - 1 }, `free bytes ${5 * GIB - 1} is past the limit ${5 * GIB}`],
  ])("defers a review with %s and logs why", (_name, disk, reason) => {
    const { gate, state } = scene(disk);

    expect(() => gate.admit("rv-octo-demo-7", [], { fixer: false })).toThrow(SpawnDeferred);
    expect(state.lines.at(-1)).toContain(`shepherd: spawn_gate deferred rv-octo-demo-7: ${reason}`);
  });

  it.each([
    ["at 15 percent free inodes", { ...roomy, freeInodes: 150_000 }],
    ["at exactly twice the last checkout", { ...roomy, freeInodes: 186_000, lastCheckoutInodes: 93_000 }],
    ["at the byte floor", { ...roomy, freeBytes: 5 * GIB }],
    ["with no reading of the filesystem", {}],
    ["on a filesystem with no fixed inode table", { freeBytes: 50 * GIB, freeInodes: 0, totalInodes: 0, lastCheckoutInodes: 3_000 }],
  ])("admits a review %s", (_name, disk) => {
    expect(scene(disk).ask("rv-octo-demo-7")).toBe(true);
  });

  it("takes the byte floor and the inode percent from the configured limits", () => {
    const state = { lines: [] as string[] };
    const gate = spawnGate({ limits: { reviewMinFreeBytes: GIB, reviewMinFreeInodesPct: 50 }, read: () => idle, disk: () => ({ ...roomy, freeBytes: 2 * GIB, freeInodes: 499_999 }), log: (line) => void state.lines.push(line) });

    expect(() => gate.admit("rv-octo-demo-7", [], { fixer: false })).toThrow("free inodes 499999 is past the limit 500000");
  });

  it("never holds a spawn that is no review to the checkout filesystem", () => {
    const { gate, state } = scene({ ...roomy, freeBytes: 0 }, [1, 2, 3]);

    gate.admit("fx-demo-abc");

    expect(state.lines.at(-1)).toBe("shepherd: spawn_gate admitted fx-demo-abc (load5 2, pressure 1, free 85%)");
  });

  it("defers a review while three reviews run, and admits it once one ends", () => {
    const { state, ask } = scene(roomy, [1_000, 2_000, 3_000]);

    expect(ask("rv-octo-demo-7")).toBe(false);
    expect(state.lines.at(-1)).toContain("shepherd: spawn_gate deferred rv-octo-demo-7: 3 reviews are running, the concurrent cap 3");
    state.running = [1_000, 2_000];
    expect(ask("rv-octo-demo-7")).toBe(true);
  });

  it("takes the concurrent cap from the configured limits", () => {
    const gate = spawnGate({ limits: { maxConcurrentReviews: 1 }, read: () => idle, disk: () => roomy, log: () => undefined });

    expect(() => gate.admit("rv-octo-demo-7", [1_000], { fixer: false })).toThrow("1 reviews are running, the concurrent cap 1");
  });

  it("keeps a review deferred for room its place ahead of a newer intent once room returns", () => {
    const { state, ask } = scene({ ...roomy, freeBytes: 0 }, [], { maxConcurrentReviews: 1 });
    expect(ask("rv-old-1", { fixer: false, intentAt: 10_000 })).toBe(false);
    expect(state.lines.at(-1)).toContain("deferred: queue position 1 of 1");
    state.disk = roomy;

    expect(ask("rv-new-2", { fixer: false, intentAt: 50_000 })).toBe(false);
    expect(state.lines.at(-1)).toContain("the review rv-old-1 with an older intent waits ahead");
    expect(ask("rv-old-1", { fixer: false, intentAt: 10_000 })).toBe(true);
  });

  it("logs the checkout filesystem reading with a review's admission", () => {
    const { ask, state } = scene(roomy);

    ask("rv-octo-demo-7");

    expect(state.lines.at(-1)).toBe(`shepherd: spawn_gate admitted rv-octo-demo-7 (load5 2, pressure 1, free 85%; checkout fs ${50 * GIB} bytes, 800000 of 1000000 inodes free, last checkout 3000 inodes; 0 reviews running)`);
  });
});
