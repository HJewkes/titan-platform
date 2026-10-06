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
import { admitSpawn, DEFAULT_SPAWN_LIMITS, spawnGate, SpawnDeferred, type MachineReadings } from "./spawn-gate.js";
import { implementersOver } from "./wake.js";

const limits = DEFAULT_SPAWN_LIMITS;
const idle: MachineReadings = { load5: 2, pressureLevel: 1, freeMemoryPct: 85 };

describe("admitSpawn", () => {
  it("admits an idle machine with no earlier start", () => {
    expect(admitSpawn(idle, limits, [], 1_000)).toEqual({ admit: true });
  });

  it.each([
    ["load5 above the dispatch limit", { ...idle, load5: 29 }, 0],
    ["load5 above the build limit", { ...idle, load5: 21 }, 0],
    ["a running review pushing load5 past the build limit", { ...idle, load5: 17 }, 1],
    ["memory pressure at the warn level", { ...idle, pressureLevel: 2 }, 0],
    ["free memory under 20 percent", { ...idle, freeMemoryPct: 19 }, 0],
  ])("refuses on %s", (_name, readings, running) => {
    expect(admitSpawn(readings, limits, [], 1_000, running).admit).toBe(false);
  });

  it("admits at the limits themselves", () => {
    expect(admitSpawn({ load5: 20, pressureLevel: 1, freeMemoryPct: 20 }, limits, [], 1_000).admit).toBe(true);
  });

  it("refuses a second start inside the window and admits it after", () => {
    expect(admitSpawn(idle, limits, [10_000], 10_000 + limits.windowMs - 1).admit).toBe(false);
    expect(admitSpawn(idle, limits, [10_000], 10_000 + limits.windowMs).admit).toBe(true);
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
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), profile: "rv", cwdFor: () => join(dir, "co"), roster, gate: overloaded() });

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
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), profile: "rv", cwdFor: () => join(dir, "co"), roster, gate });

    await expect(agentChatAgents(bin(), { roster, gate }).resume("impl-a", "wake")).rejects.toBeInstanceOf(SpawnDeferred);
    await expect(dispatch.resume("rv-standing", "brief")).rejects.toBeInstanceOf(ReviewerBrokerBusy);
    expect(ran()).toBe(false);
  });

  it("asks again on the step's next wait and starts the reviewer once load settles, leaving no record of the deferral", async () => {
    mkdirSync(join(dir, "co"));
    const state = { load5: 40, now: 0 };
    const gate = spawnGate({ read: () => ({ ...idle, load5: state.load5 }), now: () => state.now, log: () => undefined });
    const dispatch = agentChatReviewerDispatch({ agentChatBin: bin(), profile: "rv", cwdFor: () => join(dir, "co"), roster, gate });
    const waits: string[] = [];
    const timing = { now: () => state.now, busyWaitMs: 30 * 60_000, sleep: async (ms: number) => { state.now += ms; state.load5 = 3; } };

    await whileBrokerBusy(timing, new AbortController().signal, (text) => void waits.push(text), () => dispatch.spawn("rv-octo-demo-7", "brief", { repo: "octo/demo", pr: 7, head: "a".repeat(40) }));

    expect(ran()).toBe(true);
    expect(waits).toEqual(["ReviewerBrokerBusy; asking again in 1 min"]);
  });
});
