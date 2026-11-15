import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Verbs } from "../cli-types.js";
import { defineWorkflow, dispatchStepIds } from "../definition.js";
import { deployHealth } from "../deploy-health.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { AccountLimitStore } from "../shepherd/account-store.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import { shepherdStoreRef } from "../shepherd/store.js";
import { REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { liveLaneSignals } from "./lane-signals.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const RUNNING = "a".repeat(40);
const minutesAgo = (minutes: number): number => NOW - minutes * 60_000;

/** A run that lands at once, and one that waits on CI for good. */
const landing = defineWorkflow({ name: "lane-landing", steps: [{ id: "sh-landed", kind: "dispatch" }], run: async (ctx) => void (await ctx.dispatch("sh-landed", "landed")) });
const waiting = defineWorkflow({ name: "lane-waiting", steps: [{ id: "ci-wait", kind: "dispatch" }], run: async (ctx) => void (await ctx.dispatch("ci-wait", "wait")) });

function routesOf(shepherd: FactoryRoutes): FactoryRoutes {
  const steps: StepRoute[] = [...dispatchStepIds(landing), ...dispatchStepIds(waiting)].map((match) => ({
    match,
    onRestart: "repeat",
    runner: { run: (input) => (input.stepId === "ci-wait" ? new Promise(() => undefined) : Promise.resolve({ ok: true, output: "done" })) },
  }));
  return Object.assign(steps, { database: shepherd.database, shepherd: shepherd.shepherd });
}

const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
});

interface Seed {
  /** Minutes before now that each lane run merged. */
  merged?: number[];
  /** How many lane runs still wait on CI. */
  open?: number;
  /** Minutes before now of each commit on origin/main the running build lacks. */
  originCommits?: number[];
  review?: object;
}

let prs = 0;

/** Runs a lane run to its end, or leaves it waiting, at the instant `minutes` before now, and registers it with Shepherd. */
async function seedRun(host: FactoryHost, routes: FactoryRoutes, workflow: string, minutes: number): Promise<void> {
  vi.setSystemTime(minutesAgo(minutes));
  const runId = host.runtime.start(workflow);
  prs += 1;
  routes.shepherd!.store.get().register({ repo: REPO, pr: prs, runId, task: `demo/${prs}`, implementer: "impl-a", policy: OWNER_GATE_POLICY });
  if (workflow === "lane-landing") await host.runtime.wait(runId);
  else await vi.waitFor(() => expect(host.runtime.status(runId)?.activeSteps["ci-wait"]).toBeDefined());
}

/** serve answers `/health` with a deploy block that keeps no git reading, so the deploy check asks git, which holds `originCommits`. */
async function seeded(seed: Seed) {
  const config = join(mkdtempSync(join(tmpdir(), "lane-signals-")), "config.json");
  writeFileSync(config, JSON.stringify(seed.review ? { shepherd: { agentChatBin: "/opt/agent-chat/bin", review: { profile: "reviewer", ...seed.review } } } : {}));
  const shepherd = factoryRoutesFor({ port: githubPort(fakeGitHub().wire), store: shepherdStoreRef() });
  const routes = routesOf(shepherd);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [landing, waiting], routes });
  cleanups.push(() => host.close());
  for (const minutes of seed.merged ?? []) await seedRun(host, routes, "lane-landing", minutes);
  for (let n = 0; n < (seed.open ?? 0); n += 1) await seedRun(host, routes, "lane-waiting", 1);
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ deploy: deployHealth({ entries: [], runningSha: RUNNING, now: NOW }) }) }));
  const verbs = partialFake<Verbs>({
    io: { stdout: () => {}, stderr: () => {}, env: { TITAN_FACTORY_CONFIG: config } },
    deps: { workflows: [], routes: [], serveWaitMs: 50, deployBehind: async () => ({ commitTimes: (seed.originCommits ?? []).map(minutesAgo) }) },
    withHost: async (fn) => void (await fn(host, routes)),
  });
  return { host, read: () => liveLaneSignals(verbs)({ inLane: () => true }) };
}

describe("liveLaneSignals merged-not-deployed", () => {
  it("counts nothing when the running build lacks no commit, however fresh the merge", async () => {
    const { read } = await seeded({ merged: [1] });

    const signals = await read();

    expect(signals.unread).toEqual({});
    expect(signals.mergedNotDeployed).toBe(0);
    expect(signals.deployStall).toEqual([]);
  });

  it("counts a merge made after the oldest missing commit", async () => {
    const { read } = await seeded({ merged: [5], originCommits: [20] });

    expect((await read()).mergedNotDeployed).toBe(1);
  });

  it("does not count a merge made before the oldest missing commit", async () => {
    const { read } = await seeded({ merged: [60], originCommits: [30] });

    expect((await read()).mergedNotDeployed).toBe(0);
  });

  it("counts only the merge after the cutoff when one run merged on each side", async () => {
    const { read } = await seeded({ merged: [5, 60], originCommits: [30] });

    expect((await read()).mergedNotDeployed).toBe(1);
  });

  it("leaves the merged count unread when serve answers no /health", async () => {
    const { read } = await seeded({ merged: [5], originCommits: [20] });
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect refused");
    });

    const signals = await read();

    expect(signals.mergedNotDeployed).toBeUndefined();
    expect(signals.unread.deploy).toMatch(/did not answer \/health/);
  });
});

describe("liveLaneSignals open PRs", () => {
  it("counts runs still waiting and not the one that merged", async () => {
    const { read } = await seeded({ merged: [1], open: 2 });

    expect((await read()).openPrs).toBe(2);
  });
});

describe("liveLaneSignals reviewers", () => {
  const accounts = { configDir: "/accounts/primary", fallbackConfigDirs: ["/accounts/primary", "/accounts/spare"] };

  it("counts a directory named twice once, and the exhausted ones among them", async () => {
    const { host, read } = await seeded({ review: accounts });
    new AccountLimitStore(host.db).markExhausted("/accounts/primary", NOW + 3_600_000, "limit reached");

    const signals = await read();

    expect(signals.unread).toEqual({});
    expect(signals.reviewers).toEqual({ accounts: 2, exhausted: 1 });
  });

  it("reads the one default account when none is configured", async () => {
    const { read } = await seeded({});

    expect((await read()).reviewers).toEqual({ accounts: 1, exhausted: 0 });
  });
});
