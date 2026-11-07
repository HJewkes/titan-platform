import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { configuredMergeWake, settleTrigger, type MergeWake } from "./merge-wake.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import { shepherdPrWorkflow } from "./shepherd/pr.js";
import { shepherdStoreRef } from "./shepherd/store.js";
import { gateId, gateOpened, REPO } from "./test-support/land.js";
import { OWNER } from "./test-support/resolver.js";
import { factoryRoutesFor } from "./workflows.js";
import { sleep } from "./workflows/land.js";
import type { ChoreExec } from "./workflows/post-merge.js";

/** A clock whose timers run only when the test advances it. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  return {
    setTimer: (run: () => void, ms: number) => void timers.push({ at: now + ms, run }),
    dueAt: () => timers.map((timer) => timer.at),
    now: () => now,
    async advanceTo(at: number) {
      const due = timers.filter((timer) => timer.at <= at).sort((a, b) => a.at - b.at);
      timers.splice(0, timers.length, ...timers.filter((timer) => timer.at > at));
      for (const timer of due) {
        now = timer.at;
        timer.run();
      }
      now = at;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function countingTrigger(settleMs = 20_000, fire: () => Promise<void> = async () => undefined) {
  const clock = fakeClock();
  const fires: number[] = [];
  const trigger = settleTrigger({ settleMs, setTimer: clock.setTimer, fire: () => (fires.push(clock.now()), fire()) });
  const at = (ms: number) => clock.advanceTo(ms);
  return { trigger, fires, at, clock };
}

describe("the settle trigger", () => {
  it("fires once when the window after a single event ends", async () => {
    const { trigger, fires, at } = countingTrigger();
    trigger.event();
    await at(19_999);
    expect(fires).toEqual([]);
    await at(20_000);
    expect(fires).toEqual([20_000]);
  });

  it("absorbs a second event inside the window into the first fire", async () => {
    const { trigger, fires, at } = countingTrigger();
    trigger.event();
    await at(5_000);
    trigger.event();
    await at(60_000);
    expect(fires).toEqual([20_000]);
  });

  it("arms a fresh window for an event after the last fire", async () => {
    const { trigger, fires, at, clock } = countingTrigger();
    trigger.event();
    await at(20_000);
    await at(25_000);
    trigger.event();
    expect(clock.dueAt()).toEqual([45_000]);
    await at(45_000);
    expect(fires).toEqual([20_000, 45_000]);
  });

  it("still fires the next window after a fire that rejects", async () => {
    const errors: unknown[] = [];
    const clock = fakeClock();
    let calls = 0;
    const trigger = settleTrigger({ settleMs: 1_000, setTimer: clock.setTimer, fire: async () => ((calls += 1), Promise.reject(new Error("unit not found"))), onError: (error) => errors.push(error) });
    trigger.event();
    await clock.advanceTo(1_000);
    trigger.event();
    await clock.advanceTo(2_000);
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
  });
});

describe("the configured merge wake", () => {
  it("is absent when the config names no wake", () => {
    expect(configuredMergeWake(undefined)).toBeUndefined();
  });

  it("runs the configured argv with its cwd and timeout, and logs a failing exit", async () => {
    const calls: Parameters<ChoreExec>[] = [];
    const lines: string[] = [];
    const exec: ChoreExec = async (...args) => (calls.push(args), { exitCode: 5, signal: null, timedOut: false, stdout: "", stderr: "" });
    const clock = fakeClock();
    const wake = configuredMergeWake({ argv: ["systemctl", "--user", "start", "burndown.service"], cwd: "/srv/tester", timeoutMs: 7_000 }, { exec, log: (line) => lines.push(line), setTimer: clock.setTimer });
    wake!.event();
    expect(clock.dueAt()).toEqual([20_000]);
    await clock.advanceTo(20_000);
    expect(calls.map(([argv, options]) => [argv, options.cwd, options.timeoutMs])).toEqual([[["systemctl", "--user", "start", "burndown.service"], "/srv/tester", 7_000]]);
    expect(lines).toEqual([expect.stringContaining("merge-wake failed")]);
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Two open PRs; every head and main commit reads green, served by shepherd-pr over the production route set. */
function landingWorld(mergeWake: MergeWake) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: fakeSha("wake-head-1") });
  fake.addPr({ headSha: fakeSha("wake-head-2") });
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (fake.setRuns(sha, [successRun("validate", 1), successRun("dag-check", 2)]), base.checkRuns(repo, sha)) };
  let clock = 0;
  const routes = factoryRoutesFor({ port, store: shepherdStoreRef(), now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), mergeWake });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake };
}

async function landBoth(world: ReturnType<typeof landingWorld>): Promise<void> {
  const runs = [1, 2].map((pr) => world.host.runtime.start("shepherd-pr", { repo: REPO, pr: String(pr), policy: JSON.stringify(OWNER_GATE_POLICY) }));
  for (const [index, runId] of runs.entries()) {
    await gateOpened(world.host, gateId(runId, "approve-merge"));
    world.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: world.fake.pr(index + 1).headSha }, OWNER);
    await world.host.runtime.wait(runId);
  }
}

describe("a Shepherd merge wakes the tick", () => {
  it("starts one tick within 30 s for two merges inside the settle window", async () => {
    const { trigger, fires, at, clock } = countingTrigger();
    const world = landingWorld(trigger);
    await landBoth(world);
    expect([world.fake.pr(1).merged, world.fake.pr(2).merged]).toEqual([true, true]);
    const [due] = clock.dueAt();
    expect(clock.dueAt()).toHaveLength(1);
    expect(due).toBeLessThanOrEqual(30_000);
    await at(due!);
    expect(fires).toEqual([due]);
  });
});
