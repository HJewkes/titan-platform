import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentChatAgents } from "./agents.js";
import { fixersOver } from "./main-red.js";
import { ReviewerBrokerBusy } from "./review.js";
import { whileBrokerBusy } from "./review-wait.js";
import { agentChatReviewerDispatch } from "./reviewer-dispatch.js";
import type { RosterReader } from "./roster.js";
import { admitSpawn, DEFAULT_SPAWN_LIMITS, REVIEW_STALE_MS, spawnGate, SpawnDeferred, type MachineReadings, type ReviewAsk } from "./spawn-gate.js";
import { implementersOver } from "./wake.js";

const limits = DEFAULT_SPAWN_LIMITS;
const idle: MachineReadings = { load5: 2, pressureLevel: 1, freeMemoryPct: 85 };

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

  it("refuses a second start inside the window and admits it after when load5 is at half of buildLoad5", () => {
    const busy = { ...idle, load5: limits.buildLoad5 / 2 };
    expect(admitSpawn(busy, limits, [10_000], 10_000 + limits.windowMs - 1)).toEqual({ admit: false, reason: "another spawn was admitted 59999 ms ago, inside the 60000 ms window" });
    expect(admitSpawn(busy, limits, [10_000], 10_000 + limits.windowMs).admit).toBe(true);
  });

  it("admits a second start after the shorter headroom interval on a machine with headroom", () => {
    expect(admitSpawn(idle, limits, [10_000], 10_000 + limits.headroomIntervalMs - 1)).toEqual({ admit: false, reason: "another spawn was admitted 14999 ms ago, inside the 15000 ms headroom interval" });
    expect(admitSpawn(idle, limits, [10_000], 10_000 + limits.headroomIntervalMs)).toEqual({ admit: true });
  });

  it.each([
    ["load5 at half of buildLoad5", { ...idle, load5: 10 }, []],
    ["memory pressure unread", { load5: 2, freeMemoryPct: 85 }, []],
    ["unabsorbed reviews at their headroom cap", idle, [1_000, 2_000, 3_000, 4_000]],
  ])("keeps the 60 s window with %s", (_name, readings, running) => {
    const now = 100_000;
    expect(admitSpawn(readings, limits, [now - limits.headroomIntervalMs], now, running).admit).toBe(false);
    expect(admitSpawn(readings, limits, [now - limits.windowMs], now, running).admit).toBe(true);
  });

  it("refuses past the burst cap of admits inside any window, even with headroom", () => {
    const fast = { ...limits, headroomIntervalMs: 5_000 };
    const starts = [10_000, 15_000, 20_000, 25_000];
    expect(admitSpawn(idle, fast, starts, 10_000 + limits.windowMs - 1)).toEqual({ admit: false, reason: "4 spawns were admitted inside the last 60000 ms, the burst cap 4" });
    expect(admitSpawn(idle, fast, starts, 10_000 + limits.windowMs)).toEqual({ admit: true });
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

  it("admits one of a burst of four ready reviews per window", () => {
    const { gate, state } = scene(idle);
    const names = ["rv-a-1", "rv-b-2", "rv-c-3", "rv-d-4"];
    const admitted: string[] = [];
    const tryAll = () => names.filter((name) => !admitted.includes(name)).forEach((name) => { try { gate.admit(name); admitted.push(name); } catch { /* deferred */ } });

    tryAll();
    expect(admitted).toEqual(["rv-a-1"]);
    state.now += limits.windowMs;
    tryAll();
    expect(admitted).toEqual(["rv-a-1", "rv-b-2"]);
  });

  it("admits a review every headroom interval on an idle machine, up to the configured burst cap per window", () => {
    const state = { now: 1_000 };
    const gate = spawnGate({ limits: { headroomIntervalMs: 10_000, burstMax: 3 }, read: () => idle, now: () => state.now, log: () => undefined });
    const admittedAt: number[] = [];
    for (; state.now <= 61_000; state.now += 10_000) {
      try { gate.admit(`rv-${state.now}`); admittedAt.push(state.now); } catch { /* deferred */ }
    }

    expect(admittedAt).toEqual([1_000, 11_000, 21_000, 61_000]);
  });

  it("admits a burst of ordinary reviews first come per poll, as with no review facts", () => {
    const { gate, state } = scene(idle);
    const names = ["rv-a-1", "rv-b-2", "rv-c-3"];
    const admitted: string[] = [];
    const tryAll = () => names.filter((name) => !admitted.includes(name)).forEach((name) => { try { gate.admit(name, [], { fixer: false }); admitted.push(name); } catch { /* deferred */ } });

    tryAll();
    state.now += limits.windowMs;
    tryAll();

    expect(admitted).toEqual(["rv-a-1", "rv-b-2"]);
  });
});

describe("spawnGate review priority", () => {
  const ordinary: ReviewAsk = { fixer: false };
  const fixer: ReviewAsk = { fixer: true };
  const scene = () => {
    const state = { readings: { ...idle, load5: 21 }, now: 1_000, lines: [] as string[] };
    const gate = spawnGate({ read: () => state.readings, now: () => state.now, log: (line) => void state.lines.push(line) });
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
    for (let round = 0; round < 3; round++, state.now += limits.windowMs) poll();

    expect(admitted).toEqual(["rv-fix-3", "rv-a-1", "rv-b-2"]);
  });

  it("refuses an ordinary review with a reason naming the waiting fix review", () => {
    const { state, gate, ask } = scene();
    ask("rv-fix-3", fixer);
    state.readings = idle;

    expect(() => gate.admit("rv-a-1", [], ordinary)).toThrow("the review rv-fix-3 of a red main's fix waits ahead");
  });

  it("stops holding the queue for a fix review that has not asked within the stale interval", () => {
    const { state, ask } = scene();
    ask("rv-fix-3", fixer);
    state.readings = idle;

    state.now += REVIEW_STALE_MS;
    const admittedAtInterval = ask("rv-a-1", ordinary);
    state.now += 1;
    const admittedAfterInterval = ask("rv-a-1", ordinary);

    expect({ admittedAtInterval, admittedAfterInterval }).toEqual({ admittedAtInterval: false, admittedAfterInterval: true });
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
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "titan-spawn-gate-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const bin = () => {
    const path = join(dir, "agent-chat");
    writeFileSync(path, `#!/bin/sh\n: >"${dir}/ran"\nexit 0\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const ran = () => existsSync(join(dir, "ran"));
  const roster: RosterReader = { read: async () => ({ known: true, rows: [] }) as never, rows: async () => [], invalidate: () => undefined };
  const overloaded = () => spawnGate({ read: () => ({ ...idle, load5: 40 }), log: () => undefined });

  it("defers a reviewer spawn as a busy refusal and starts nobody", async () => {
    mkdirSync(join(dir, "co"));
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), roles: { g10: "rv", standard: "rv" }, cwdFor: () => join(dir, "co"), roster, gate: overloaded() });

    await expect(dispatch.spawn("rv-octo-demo-7", "brief", { repo: "octo/demo", pr: 7, head: "a".repeat(40) })).rejects.toBeInstanceOf(ReviewerBrokerBusy);
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

  it("defers the resume of an exited agent, for the standing reviewer as a busy refusal, and starts nobody", async () => {
    mkdirSync(join(dir, "co"));
    const gate = overloaded();
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), roles: { g10: "rv", standard: "rv" }, cwdFor: () => join(dir, "co"), roster, gate });

    await expect(agentChatAgents(bin(), { roster, gate }).resume("impl-a", "wake")).rejects.toBeInstanceOf(SpawnDeferred);
    await expect(dispatch.resume("rv-standing", "brief")).rejects.toBeInstanceOf(ReviewerBrokerBusy);
    expect(ran()).toBe(false);
  });

  it("spawns the reviewer of a frozen repo's fix PR before two reviewers that asked earlier", async () => {
    mkdirSync(join(dir, "co"));
    const state = { load5: 21, now: 0, admitted: [] as string[] };
    const log = (line: string) => void (line.startsWith("shepherd: spawn_gate admitted ") && state.admitted.push(line.split(" ")[3] ?? ""));
    const gate = spawnGate({ read: () => ({ ...idle, load5: state.load5 }), now: () => state.now, log });
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), roles: { g10: "rv", standard: "rv" }, cwdFor: () => join(dir, "co"), roster, gate, isFixer: ({ pr }) => pr === 9 });
    const prs = [7, 8, 9];
    const poll = async () => {
      for (const pr of prs.filter((pr) => !state.admitted.includes(`rv-octo-demo-${pr}`))) await dispatch.spawn(`rv-octo-demo-${pr}`, "brief", { repo: "octo/demo", pr, head: "a".repeat(40) }).catch(() => undefined);
    };

    await poll();
    state.load5 = 3;
    for (let round = 0; round < 3; round++, state.now += limits.windowMs) await poll();

    expect(state.admitted).toEqual(["rv-octo-demo-9", "rv-octo-demo-7", "rv-octo-demo-8"]);
  });

  it("asks again on the step's next wait and starts the reviewer once load settles, leaving no record of the deferral", async () => {
    mkdirSync(join(dir, "co"));
    const state = { load5: 40, now: 0 };
    const gate = spawnGate({ read: () => ({ ...idle, load5: state.load5 }), now: () => state.now, log: () => undefined });
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), roles: { g10: "rv", standard: "rv" }, cwdFor: () => join(dir, "co"), roster, gate });
    const waits: string[] = [];
    const timing = { now: () => state.now, busyWaitMs: 30 * 60_000, sleep: async (ms: number) => { state.now += ms; state.load5 = 3; } };

    await whileBrokerBusy(timing, new AbortController().signal, (text) => void waits.push(text), () => dispatch.spawn("rv-octo-demo-7", "brief", { repo: "octo/demo", pr: 7, head: "a".repeat(40) }));

    expect(ran()).toBe(true);
    expect(waits).toEqual(["ReviewerBrokerBusy; asking again in 1 min"]);
  });
});
