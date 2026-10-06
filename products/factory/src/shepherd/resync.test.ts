import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runCli } from "../cli.js";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { startFactoryServer, type FactoryServer, type FactoryServerOptions } from "../serve.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep, step } from "../workflows/land.js";
import { MergeResultResult } from "../workflows/land-steps.js";
import { SHEPHERD_WORKFLOW } from "./commands.js";
import { CLOSED_ELSEWHERE, DELETED_ELSEWHERE, LANDED_ELSEWHERE, endRunsGoneElsewhere, mergedByShepherd } from "./gone-elsewhere.js";
import { shepherdPrWorkflow } from "./pr.js";
import { authorityGate } from "./head-moved.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { ORPHANED, resyncShepherd, supersedeTransientGates, transientOnlyConditions } from "./resync.js";
import { LEAKY_MESSAGE, expectNoLeak } from "../test-support/leak.js";
import { FINISHED_RUN_STATUSES } from "./run-status.js";
import { shepherdStoreRef } from "./store.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const SEED_LEASE_MS = 3_000;
const AFTER_LEASE = T0 + 60_000;
const HEAD = fakeSha("resync-head");
const AWAIT_VERDICT = "sh-await-verdict";

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-resync-"));
  dirs.push(dir);
  return join(dir, "state", "factory.sqlite3");
}

/** Review says MERGE, so an owner-gated run parks on approve-merge; a run started with `freeze` first waits on a verdict step. */
const PHASES = {
  wake: async () => ({ kind: "unhandled" as const, reason: "test" }),
  review: async (ctx: Parameters<typeof step>[0], request: { headSha: string }) => {
    if (ctx.param("freeze") === "1") await step(ctx, AWAIT_VERDICT, {}, z.unknown());
    return { kind: "MERGE" as const, headSha: request.headSha, evidence: {} };
  },
};

/** The step's runner never settles, the way a reviewer that died in a reboot leaves its wait. */
function hangingAt(routes: FactoryRoutes, stepId: string): FactoryRoutes {
  const hung: StepRoute[] = routes.map((route) => ({
    ...route,
    runner: { run: (input) => (input.stepId.startsWith(stepId) ? new Promise(() => undefined) : route.runner.run(input)) },
  }));
  return Object.assign(hung, { database: routes.database, shepherd: routes.shepherd });
}

interface World {
  dbPath: string;
  fake: FakeGitHub;
  /** The seed's routes; a store binds to one open database, so every later host takes `freshRoutes()`. */
  routes: FactoryRoutes;
  freshRoutes(): FactoryRoutes;
  workflows: WorkflowDefinition[];
  /** The host that went down: its clock is frozen and it never releases a lease. */
  seed: FactoryHost;
}

function world(options: { hangAt?: string; workflows?: WorkflowDefinition[] } = {}): World {
  const dbPath = dbFile();
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const freshRoutes = (): FactoryRoutes =>
    factoryRoutesFor({ port: githubPort(fake.wire), store: shepherdStoreRef(), now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const workflows = options.workflows ?? [shepherdPrWorkflow(PHASES)];
  const routes = hangingAt(freshRoutes(), options.hangAt ?? AWAIT_VERDICT);
  const seed = openFactoryHost({ dbPath, workflows, routes, now: () => T0, leaseMs: SEED_LEASE_MS, gatePollMs: 10 });
  cleanups.push(() => seed.close());
  return { dbPath, fake, routes, freshRoutes, workflows, seed };
}

function startShepherd(w: World, pr: number, params: Record<string, string> = {}): string {
  w.fake.addPr({ headSha: HEAD });
  const runId = w.seed.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: String(pr), policy: JSON.stringify(OWNER_GATE_POLICY), ...params });
  w.routes.shepherd!.store.get().register({ repo: REPO, pr, runId, task: `demo/${pr}`, implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return runId;
}

async function gatedRun(w: World, pr: number): Promise<string> {
  const runId = startShepherd(w, pr);
  await gateOpened(w.seed, gateId(runId, "approve-merge"));
  return runId;
}

async function untilActive(host: FactoryHost, runId: string, stepId: string): Promise<void> {
  while (!Object.keys(host.runtime.status(runId)?.activeSteps ?? {}).some((key) => key.startsWith(stepId))) await sleep(5, new AbortController().signal);
}

async function stuckRun(w: World, pr: number, stepId: string, params: Record<string, string> = {}): Promise<string> {
  const runId = startShepherd(w, pr, params);
  await untilActive(w.seed, runId, stepId);
  return runId;
}

const merge = (fake: FakeGitHub, pr: number): void => void Object.assign(fake.pr(pr), { merged: true, state: "closed" });

async function serve(w: World, overrides: Partial<FactoryServerOptions> = {}): Promise<FactoryServer> {
  const server = await startFactoryServer({
    dbPath: w.dbPath,
    workflows: w.workflows,
    routes: w.freshRoutes(),
    now: () => AFTER_LEASE,
    gatePollMs: 10,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "test", behindMain: { status: () => 0, refresh: async () => undefined } },
    ...overrides,
  });
  cleanups.push(() => server.close());
  return server;
}

async function settled(host: FactoryHost, runId: string): Promise<WorkflowRun> {
  for (;;) {
    const run = host.runtime.status(runId)!;
    if (FINISHED_RUN_STATUSES.has(run.status)) return run;
    await sleep(5, new AbortController().signal);
  }
}

describe("shepherd resync at serve start", () => {
  it("ends two gated runs and a frozen review whose PRs merged while the service was down, and no owner gate stays pending", async () => {
    const w = world();
    const gated = [await gatedRun(w, 1), await gatedRun(w, 2)];
    const frozen = await stuckRun(w, 3, AWAIT_VERDICT, { freeze: "1" });
    [1, 2, 3].forEach((pr) => merge(w.fake, pr));

    const server = await serve(w);
    const runs = await Promise.all([...gated, frozen].map((runId) => settled(server.host, runId)));
    await sleep(50, new AbortController().signal);

    expect(runs.map((run) => run.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(runs.map((run) => run.error?.startsWith(LANDED_ELSEWHERE))).toEqual([true, true, true]);
    expect(server.host.pendingGates()).toEqual([]);
  });

  it("a run registered while the service was down on a PR that has since merged is cancelled, not recorded as landed", async () => {
    const w = world({ hangAt: "land-rules" });
    const runId = await stuckRun(w, 1, "land-rules");
    merge(w.fake, 1);

    const server = await serve(w);
    const run = await settled(server.host, runId);

    expect(run.status).toBe("cancelled");
    expect(Object.keys(run.stepResults).filter((key) => key.startsWith("sh-main-ci") || key.startsWith("sh-outcome"))).toEqual([]);
    expect(w.fake.effects.merge).toBe(0);
  });

  it("a closed, unmerged PR ends its run as closed elsewhere", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    w.fake.pr(1).state = "closed";

    const server = await serve(w);
    const run = await settled(server.host, runId);

    expect(run.error).toBe(`${CLOSED_ELSEWHERE}${REPO}#1 was closed outside Shepherd`);
  });

  it("an unreadable PR leaves its run alone and startup still completes", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    merge(w.fake, 1);
    const fresh = w.freshRoutes();
    const shepherd = { ...fresh.shepherd!, port: { ...fresh.shepherd!.port, getPr: async () => Promise.reject(new Error("rate limited")) } };
    const routes = Object.assign([...fresh], { database: fresh.database, shepherd });

    const server = await serve(w, { routes });
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(health.ok).toBe(true);
    expect(server.host.runtime.status(runId)?.status).toBe("paused");
    expect(server.host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });

  it("a resync that throws is logged, and the server still starts with every run untouched", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    merge(w.fake, 1);
    const fresh = w.freshRoutes();
    const routes = Object.assign([...fresh], { database: fresh.database, shepherd: { ...fresh.shepherd!, store: { ...fresh.shepherd!.store, get: () => { throw new Error("store unreadable"); } } } });
    const errors: string[] = [];
    const logger = { ...silentLogger, error: (_fields: unknown, message: string) => void errors.push(message) };

    const server = await serve(w, { routes, logger });
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(health.ok).toBe(true);
    expect(errors).toContain("shepherd resync at start failed");
    expect(server.host.runtime.status(runId)?.status).toBe("paused");
    expect(server.host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });
});

/** A shepherd-pr stand-in that merges the PR itself and then waits on the main-red gate, as a red main after its merge would. */
function mergedThenRed(): WorkflowDefinition {
  return defineWorkflow({
    name: SHEPHERD_WORKFLOW,
    steps: [
      { id: "merge", kind: "dispatch" },
      { id: "main-red", kind: "assisted" },
    ],
    run: async (ctx) => {
      await step(ctx, "merge:0", { repo: REPO, pr: 1, sha: HEAD, method: "squash" }, MergeResultResult);
      await ctx.assisted("main-red", "main went red after this merge");
    },
  });
}

/** Asks the owner first, then merges, records the landing, and waits on main-red: Shepherd's own merge end to end. */
function approveThenMerge(): WorkflowDefinition {
  return defineWorkflow({
    name: SHEPHERD_WORKFLOW,
    steps: [
      { id: "approve-merge", kind: "assisted" },
      { id: "merge", kind: "dispatch" },
      { id: "sh-landed", kind: "dispatch" },
      { id: "main-red", kind: "assisted" },
    ],
    run: async (ctx) => {
      await ctx.assisted("approve-merge", "merge this head?");
      await step(ctx, "merge:0:0", { repo: REPO, pr: 1, sha: HEAD, method: "squash" }, MergeResultResult);
      await step(ctx, "sh-landed", { repo: REPO, pr: 1 }, z.unknown());
      await ctx.assisted("main-red", "main went red after this merge");
    },
  });
}

describe("resyncShepherd when superseding moved gates throws", () => {
  it("still reports the runs it ended and the error class, never its text", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    merge(w.fake, 1);
    const routes = w.freshRoutes();
    const host = openFactoryHost({ dbPath: w.dbPath, workflows: w.workflows, routes, now: () => AFTER_LEASE, gatePollMs: 10 });
    cleanups.push(() => host.close());
    const services = routes.shepherd!;
    const broken: FactoryHost = Object.assign(Object.create(host) as FactoryHost, {
      pendingGates: () => {
        throw new Error(LEAKY_MESSAGE);
      },
    });

    const report = await resyncShepherd(broken, services);

    expect(report.ended.map((ended) => ended.runId)).toEqual([runId]);
    expect(report.supersedeError).toBe("Error");
    expectNoLeak(report);
  });
});

describe("resyncShepherd when a cancel fails for a reason other than a lease", () => {
  it("keeps the run held for the recheck before adoption and reports the cause as an error class, never its text", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    merge(w.fake, 1);
    const routes = w.freshRoutes();
    const host = openFactoryHost({ dbPath: w.dbPath, workflows: w.workflows, routes, now: () => AFTER_LEASE, gatePollMs: 10 });
    cleanups.push(() => host.close());
    vi.spyOn(host.runtime, "cancel").mockImplementation(() => {
      throw new Error(LEAKY_MESSAGE);
    });

    const report = await resyncShepherd(host, routes.shepherd!);

    expect(report.ended).toEqual([]);
    expect(report.held).toEqual([runId]);
    expect(report.cancelErrors).toEqual([{ runId, cause: "Error" }]);
    expectNoLeak(report);
  });
});

describe("endRunsGoneElsewhere while the run moves on", () => {
  it("keeps a run whose own merge is recorded while its PR read is in flight", async () => {
    const w = world({ workflows: [approveThenMerge()] });
    const runId = startShepherd(w, 1);
    await gateOpened(w.seed, gateId(runId, "approve-merge"));
    const services = w.routes.shepherd!;
    const getPr: typeof services.port.getPr = async (repo, pr) => {
      w.seed.runtime.signal(runId, "approve-merge", {}, OWNER);
      await gateOpened(w.seed, gateId(runId, "main-red"));
      return services.port.getPr(repo, pr);
    };

    const ended = await endRunsGoneElsewhere(w.seed, { ...services, port: { ...services.port, getPr } });

    expect(ended).toEqual([]);
    expect(w.fake.effects.merge).toBe(1);
    expect(w.seed.runtime.status(runId)?.status).toBe("paused");
    expect(w.seed.gates.get(gateId(runId, "main-red"))?.status).toBe("pending");
  });

  it("does not count a run that ended while its PR read was in flight", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    merge(w.fake, 1);
    const services = w.routes.shepherd!;
    const getPr: typeof services.port.getPr = async (repo, pr) => {
      w.seed.runtime.cancel(runId, "abandoned by the owner");
      await w.seed.runtime.wait(runId);
      return services.port.getPr(repo, pr);
    };

    const ended = await endRunsGoneElsewhere(w.seed, { ...services, port: { ...services.port, getPr } });

    expect(ended).toEqual([]);
    expect(w.seed.runtime.status(runId)?.error).toBe("abandoned by the owner");
  });

  it("counts a recorded sh-landed step as Shepherd's own merge", () => {
    const landed = { stepResults: { "sh-landed": {} }, activeSteps: {} } as unknown as WorkflowRun;
    const reviewing = { stepResults: { "merge-policy:0": {} }, activeSteps: { "sh-await-verdict:0": {} } } as unknown as WorkflowRun;

    expect([mergedByShepherd(landed), mergedByShepherd(reviewing)]).toEqual([true, false]);
  });
});

describe("resyncShepherd", () => {
  it("leaves the post-merge gate of a run Shepherd merged itself, in the resync and in the periodic sweep", async () => {
    const w = world({ workflows: [mergedThenRed()] });
    const runId = startShepherd(w, 1);
    await gateOpened(w.seed, gateId(runId, "main-red"));

    const report = await resyncShepherd(w.seed, w.routes.shepherd!);
    const swept = await endRunsGoneElsewhere(w.seed, w.routes.shepherd!);

    expect(w.fake.pr(1).merged).toBe(true);
    expect(report.ended).toEqual([]);
    expect(swept).toEqual([]);
    expect(w.seed.gates.get(gateId(runId, "main-red"))?.status).toBe("pending");
  });

  it("cancels a pending gate of a failed run as orphaned", async () => {
    const w = world();
    w.fake.addPr({ headSha: HEAD });
    const runId = w.seed.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY), after: "not json" });
    await w.seed.runtime.wait(runId);
    w.seed.gates.create({ id: gateId(runId, "sh-sent-back"), prompt: "sent back at an old head" });

    const report = await resyncShepherd(w.seed, w.routes.shepherd!);

    expect(w.seed.runtime.status(runId)?.status).toBe("failed");
    expect(report.orphanGates).toEqual([gateId(runId, "sh-sent-back")]);
    expect(w.seed.gates.get(gateId(runId, "sh-sent-back"))).toMatchObject({ status: "cancelled" });
    expect(w.seed.pendingGates()).toEqual([]);
    expect(ORPHANED).toMatch(/^orphaned: /);
  });

  it("a dry run reports what it would end and cancel, and writes nothing", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    merge(w.fake, 1);
    const failed = w.seed.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "9", policy: JSON.stringify(OWNER_GATE_POLICY), after: "not json" });
    await w.seed.runtime.wait(failed);
    w.seed.gates.create({ id: gateId(failed, "sh-sent-back"), prompt: "sent back" });

    const report = await resyncShepherd(w.seed, w.routes.shepherd!, { dryRun: true });

    expect(report).toMatchObject({ dryRun: true, ended: [{ runId, reason: `${LANDED_ELSEWHERE}${REPO}#1 was merged outside Shepherd` }], orphanGates: [gateId(failed, "sh-sent-back")] });
    expect(w.seed.runtime.status(runId)?.status).toBe("paused");
    expect(w.seed.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
    expect(w.seed.gates.get(gateId(failed, "sh-sent-back"))?.status).toBe("pending");
  });
});

describe("titan-factory shepherd resync", () => {
  it("--dry-run against the local database prints one line per run it would end and changes nothing", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    merge(w.fake, 1);
    let out = "";
    const io = { stdout: (t: string) => void (out += t), stderr: () => undefined, env: {} };
    const deps = { workflows: w.workflows, routes: w.freshRoutes(), host: { gatePollMs: 5 }, logger: silentLogger };

    const code = await runCli(["--db", w.dbPath, "shepherd", "resync", "--dry-run", "--port", "1"], io, deps);

    expect(code).toBe(0);
    expect(out).toBe(`run ${runId.slice(0, 8)} would end: ${LANDED_ELSEWHERE}${REPO}#1 was merged outside Shepherd\nwould cancel 0 orphaned gate(s); would supersede 0 stale gate(s)\n`);
    expect(w.seed.runtime.status(runId)?.status).toBe("paused");
    expect(w.seed.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });
});

describe("recheck before adoption", () => {
  const LEASE_MS = 40;
  afterEach(() => vi.useRealTimers());

  /** The seed died a second ago: its lease is still live at `now`, so start resync cannot cancel its run. */
  async function crashRestart(w: World, now: { value: number }): Promise<FactoryServer> {
    return serve(w, { now: () => now.value, leaseMs: LEASE_MS });
  }

  const never = (run: WorkflowRun): string[] => Object.keys(run.stepResults).filter((key) => key.startsWith("sh-main-ci") || key.startsWith("sh-landed") || key.startsWith("sh-outcome"));

  it.each([
    ["merged", LANDED_ELSEWHERE, (w: World) => merge(w.fake, 1)],
    ["closed", CLOSED_ELSEWHERE, (w: World) => void (w.fake.pr(1).state = "closed")],
  ])("a run skipped for a live foreign lease on a PR %s elsewhere is ended at adoption, never driven", async (_name, reason, leave) => {
    const w = world({ hangAt: "land-rules" });
    const runId = await stuckRun(w, 1, "land-rules");
    leave(w);
    const now = { value: T0 + 1_000 };

    const server = await crashRestart(w, now);
    expect(server.host.runtime.status(runId)?.status).toBe("running");
    now.value = AFTER_LEASE;
    const run = await settled(server.host, runId);

    expect(run.status).toBe("cancelled");
    expect(run.error?.startsWith(reason)).toBe(true);
    expect(never(run)).toEqual([]);
    expect(w.fake.effects.merge).toBe(0);
  });

  describe("a held run whose PR read fails", () => {
    /** Fake only the sweep interval, so the test steps ticks itself instead of sleeping through real lease time. */
    const fakeSweepTimer = (): void => void vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const tickFor = async (ms: number): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms));

    /** getPr rejects for PR 1 only, while `unreadable.value` is set, with `failure`. */
    function flakyRoutes(w: World, unreadable: { value: boolean }, failure: Error = new Error("rate limited")): FactoryRoutes {
      const fresh = w.freshRoutes();
      const getPr = fresh.shepherd!.port.getPr.bind(fresh.shepherd!.port);
      const port = { ...fresh.shepherd!.port, getPr: async (repo: string, pr: number) => (unreadable.value && pr === 1 ? Promise.reject(failure) : getPr(repo, pr)) };
      return Object.assign([...fresh], { database: fresh.database, shepherd: { ...fresh.shepherd!, port } });
    }

    async function twoHeldRuns(unreadable: { value: boolean }, failure?: Error) {
      fakeSweepTimer();
      const w = world({ hangAt: "land-rules" });
      const runs = [await stuckRun(w, 1, "land-rules"), await stuckRun(w, 2, "land-rules")] as const;
      const now = { value: T0 + 1_000 };
      const server = await serve(w, { now: () => now.value, leaseMs: LEASE_MS, routes: flakyRoutes(w, unreadable, failure) });
      now.value = AFTER_LEASE;
      await tickFor(LEASE_MS);
      await gateOpened(server.host, gateId(runs[1], "approve-merge"));
      return { w, server, runs };
    }

    it("is neither adopted nor driven while another run in the same tick is, then adopted once the read succeeds", async () => {
      const unreadable = { value: true };
      const { server, runs } = await twoHeldRuns(unreadable);
      await tickFor(3 * LEASE_MS);

      expect(server.host.gates.get(gateId(runs[0], "approve-merge"))).toBeUndefined();
      expect(server.host.runtime.status(runs[0])?.status).toBe("running");

      unreadable.value = false;
      await tickFor(LEASE_MS);
      await gateOpened(server.host, gateId(runs[0], "approve-merge"));
      expect(server.host.runtime.status(runs[0])?.status).toBe("paused");
    });

    it("stays unreadable on a 502, then is adopted once a later read succeeds", async () => {
      const unreadable = { value: true };
      const { server, runs } = await twoHeldRuns(unreadable, Object.assign(new Error("bad gateway"), { status: 502 }));
      await tickFor(3 * LEASE_MS);

      expect(server.host.runtime.status(runs[0])?.status).toBe("running");

      unreadable.value = false;
      await tickFor(LEASE_MS);
      await gateOpened(server.host, gateId(runs[0], "approve-merge"));
      expect(server.host.runtime.status(runs[0])?.status).toBe("paused");
    });

    it("is ended as gone, naming the 404, when its PR answers not found", async () => {
      const { server, runs } = await twoHeldRuns({ value: true }, new FakeHttpError(404, "no pull 1"));
      await tickFor(LEASE_MS);
      const run = await settled(server.host, runs[0]);

      expect(run.status).toBe("cancelled");
      expect(run.error?.startsWith(DELETED_ELSEWHERE)).toBe(true);
      expect(run.error).toContain("404");
      expect(never(run)).toEqual([]);
    });

    it("is ended, never driven, when a later read finds its PR merged", async () => {
      const unreadable = { value: true };
      const { w, server, runs } = await twoHeldRuns(unreadable);
      await sleep(3 * LEASE_MS, new AbortController().signal);
      merge(w.fake, 1);
      unreadable.value = false;
      await tickFor(LEASE_MS);
      const run = await settled(server.host, runs[0]);

      expect(run.status).toBe("cancelled");
      expect(run.error?.startsWith(LANDED_ELSEWHERE)).toBe(true);
      expect(never(run)).toEqual([]);
    });
  });

  it("a skipped run whose PR is still open is adopted and driven as before", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const w = world();
    const runId = await gatedRun(w, 1);
    const now = { value: T0 + 1_000 };

    const server = await crashRestart(w, now);
    now.value = AFTER_LEASE;
    await vi.advanceTimersByTimeAsync(LEASE_MS);
    await gateOpened(server.host, gateId(runId, "approve-merge"));
    await vi.advanceTimersByTimeAsync(3 * LEASE_MS);

    expect(server.host.runtime.status(runId)?.status).toBe("paused");
    expect(server.host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });
});

/** Synthetic stand-ins for the gated, reviewed head and the head pushed past it. */
const REVIEWED = fakeSha("stale-gate-reviewed");
const PUSHED = fakeSha("stale-gate-pushed");
const RV = { agentId: "agent-rv-7", sessionId: "session-rv-7" };
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", seat: "trusted-seat" };

/** MRG-AU-RV facts at `head` that hold in full unless `unmet` turns one off. */
function evidenceAt(head: string, unmet: object): object {
  const checkRuns = [{ name: "validate", appId: 1, headSha: head, conclusion: "success" }];
  const merge = { head, resolver: RV, dispatchedReviewer: RV, verdict: { value: "MERGE", head }, requiredContexts: ["validate"], allowedApps: [1], checkRuns };
  return { head, merge: { ...merge, mergeTreeClean: true, repoFrozen: false, changedPaths: ["src/a.ts"], seatGrants: ["merge-on-green-approve"], kind: "correctness", ...unmet }, record: { repo: REPO, pr: 1 } };
}

async function servedHost(routes: FactoryRoutes, workflows: WorkflowDefinition[]): Promise<FactoryHost> {
  const server = await startFactoryServer({
    dbPath: ":memory:",
    workflows,
    routes,
    gatePollMs: 5,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "test", behindMain: { status: () => 0, refresh: async () => undefined } },
  });
  cleanups.push(() => server.close());
  return server.host;
}

interface AuthorityRun {
  host: FactoryHost;
  fake: FakeGitHub;
  services: NonNullable<FactoryRoutes["shepherd"]>;
  runId: string;
  reviewed: string[];
}

/** A merge:auto run gated by authority/MRG-AU at REVIEWED: its first review reads `unmet`, every later review reads clean facts. */
async function authorityGated(unmet: object, { serve = false } = {}): Promise<AuthorityRun> {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const reviewed: string[] = [];
  const phases: ShepherdPhases = {
    wake: async () => ({ kind: "unhandled", reason: "test" }),
    review: async (_ctx, request) => ({ kind: "MERGE", headSha: request.headSha, evidence: evidenceAt(request.headSha, reviewed.push(request.headSha) === 1 ? unmet : {}) }),
  };
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = serve ? await servedHost(routes, [shepherdPrWorkflow(phases)]) : openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  if (!serve) cleanups.push(() => host.close());
  fake.addPr({ headSha: REVIEWED });
  const runId = host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  await gateOpened(host, gateId(runId, "approve-merge"));
  return { host, fake, services: routes.shepherd!, runId, reviewed };
}

describe("resyncShepherd on a pending authority/MRG-AU approve-merge gate", () => {
  it("cancels a gate whose head is no longer the PR head, and the run reviews and merges the new head", async () => {
    const { host, fake, services, runId, reviewed } = await authorityGated({ mergeTreeClean: false, repoFrozen: true });
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain("Policy authority/MRG-AU:");
    fake.pushHead(1, PUSHED);

    const report = await resyncShepherd(host, services);

    expect(report.superseded).toEqual([{ runId, gateId: gateId(runId, "approve-merge"), from: REVIEWED, to: PUSHED, condition: "head-moved" }]);
    await vi.waitFor(() => expect(fake.pr(1)).toMatchObject({ merged: true, headSha: PUSHED }));
    expect(reviewed).toEqual([REVIEWED, PUSHED]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("cancelled");
  });

  it("cancels a gate whose only unmet condition was merge-tree-clean, and the run reviews the same head again and merges it", async () => {
    const { host, fake, services, runId, reviewed } = await authorityGated({ mergeTreeClean: false });

    const report = await resyncShepherd(host, services);

    expect(report.superseded).toEqual([{ runId, gateId: gateId(runId, "approve-merge"), from: REVIEWED, to: REVIEWED, condition: "merge-tree-only" }]);
    await vi.waitFor(() => expect(fake.pr(1)).toMatchObject({ merged: true, headSha: REVIEWED }));
    expect(reviewed).toEqual([REVIEWED, REVIEWED]);
  });

  it("leaves a gate at the PR head whose merge-tree-clean failure came with a lasting unmet condition", async () => {
    const { host, services, runId } = await authorityGated({ mergeTreeClean: false, verdict: { value: "MERGE", head: PUSHED } });
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain("MRG-AU-RV unmet: verdict-merge-at-head, merge-tree-clean");

    const report = await resyncShepherd(host, services);

    expect(report.superseded).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });

  it("cancels a gate a freeze alone caused once the repo has thawed, and the run reviews the same head again and merges it", async () => {
    const { host, fake, services, runId, reviewed } = await authorityGated({ repoFrozen: true });

    const report = await resyncShepherd(host, services);

    expect(report.superseded).toEqual([{ runId, gateId: gateId(runId, "approve-merge"), from: REVIEWED, to: REVIEWED, condition: "transient-only" }]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.reason).toBe(`superseded: review again: repo-not-frozen was the only unmet condition at head ${REVIEWED}`);
    await vi.waitFor(() => expect(fake.pr(1)).toMatchObject({ merged: true, headSha: REVIEWED }));
    expect(reviewed).toEqual([REVIEWED, REVIEWED]);
  });

  it("cancels a gate whose only unmet conditions were merge-tree-clean and a freeze that has thawed", async () => {
    const { host, services, runId } = await authorityGated({ mergeTreeClean: false, repoFrozen: true });

    const report = await resyncShepherd(host, services);

    expect(report.superseded).toMatchObject([{ runId, condition: "transient-only" }]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.reason).toBe(`superseded: review again: merge-tree-clean and repo-not-frozen were the only unmet conditions at head ${REVIEWED}`);
  });

  it("leaves a gate a freeze caused while the repo is still frozen", async () => {
    const { host, services, runId, reviewed } = await authorityGated({ repoFrozen: true });
    services.freeze!.get().freeze(REPO, fakeSha("red-main"));

    const report = await resyncShepherd(host, services);

    expect(report.superseded).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
    expect(reviewed).toEqual([REVIEWED]);
  });

  it("cancels the gate a freeze caused on that freeze's own fix PR while the repo is still frozen, and the run merges the same head", async () => {
    const { host, fake, services, runId, reviewed } = await authorityGated({ repoFrozen: true });
    const freezes = services.freeze!.get();
    const { episode } = freezes.freeze(REPO, fakeSha("red-main"));
    freezes.setFixTask(REPO, episode, "demo/1");
    freezes.setFixer(REPO, episode, "impl-a");

    const report = await resyncShepherd(host, services);

    expect(report.superseded).toEqual([{ runId, gateId: gateId(runId, "approve-merge"), from: REVIEWED, to: REVIEWED, condition: "transient-only" }]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.reason).toBe(`superseded: review again: repo-not-frozen was the only unmet condition at head ${REVIEWED}`);
    await vi.waitFor(() => expect(fake.pr(1)).toMatchObject({ merged: true, headSha: REVIEWED }));
    expect(reviewed).toEqual([REVIEWED, REVIEWED]);
    expect(freezes.isFrozen(REPO)).toBe(true);
  });

  it.each([
    ["another task's fix", "demo/2", "impl-a"],
    ["its task's fix spawned as another fixer", "demo/1", "impl-b"],
  ])("leaves the gate a freeze caused on a PR that is not %s while the repo is still frozen", async (_name, fixTask, fixer) => {
    const { host, services, runId, reviewed } = await authorityGated({ repoFrozen: true });
    const freezes = services.freeze!.get();
    const { episode } = freezes.freeze(REPO, fakeSha("red-main"));
    freezes.setFixTask(REPO, episode, fixTask);
    freezes.setFixer(REPO, episode, fixer);

    const report = await resyncShepherd(host, services);

    expect(report.superseded).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
    expect(reviewed).toEqual([REVIEWED]);
  });

  it("leaves the fix PR's gate when a lasting condition is unmet too", async () => {
    const { host, services, runId } = await authorityGated({ repoFrozen: true, verdict: { value: "MERGE", head: PUSHED } });
    const freezes = services.freeze!.get();
    const { episode } = freezes.freeze(REPO, fakeSha("red-main"));
    freezes.setFixTask(REPO, episode, "demo/1");
    freezes.setFixer(REPO, episode, "impl-a");

    expect((await resyncShepherd(host, services)).superseded).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });

  it("a thaw while serving supersedes the repo's gate a freeze caused, and the run merges the same head", async () => {
    const { host, fake, services, runId, reviewed } = await authorityGated({ repoFrozen: true }, { serve: true });
    const freezes = services.freeze!.get();
    freezes.freeze(REPO, fakeSha("red-main"));

    freezes.unfreeze(REPO, fakeSha("green-main"));

    await vi.waitFor(() => expect(fake.pr(1)).toMatchObject({ merged: true, headSha: REVIEWED }));
    expect(host.gates.get(gateId(runId, "approve-merge"))?.reason).toBe(`superseded: review again: repo-not-frozen was the only unmet condition at head ${REVIEWED}`);
    expect(reviewed).toEqual([REVIEWED, REVIEWED]);
  });

  it("a thaw of another repo while serving leaves the gate with the owner", async () => {
    const { host, services, runId } = await authorityGated({ repoFrozen: true }, { serve: true });
    const freezes = services.freeze!.get();
    freezes.freeze("octo/elsewhere", fakeSha("red-main"));

    freezes.unfreeze("octo/elsewhere", fakeSha("green-main"));
    await sleep(50, new AbortController().signal);

    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });

  it("a sweep scoped to another repo leaves the gate alone", async () => {
    const { host, services, runId } = await authorityGated({ repoFrozen: true });

    expect(await supersedeTransientGates(host, services, { repo: "octo/elsewhere" })).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });

  it("a dry run reports a merge-tree-only gate and cancels nothing", async () => {
    const { host, services, runId, reviewed } = await authorityGated({ mergeTreeClean: false });

    const report = await resyncShepherd(host, services, { dryRun: true });

    expect(report.superseded).toMatchObject([{ runId, condition: "merge-tree-only" }]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
    expect(reviewed).toEqual([REVIEWED]);
  });

  it("leaves a seat owner-gate gate at the PR head with the owner", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);

    const report = await resyncShepherd(w.seed, w.routes.shepherd!);

    expect(report.superseded).toEqual([]);
    expect(w.seed.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });
});

describe("which recorded gate decisions are authority/MRG-AU gates", () => {
  const PROMPT = `Merge PR #1 in ${REPO} at head ${REVIEWED}? CI is green.`;
  const MERGE_TREE_ONLY = "the authority policy did not allow an automated merge: MRG-AU gates merge by automation; MRG-AU-RV unmet: merge-tree-clean";

  function runDeciding(result: object): WorkflowRun {
    const output = JSON.stringify({ result: { outcome: "gate", headSha: REVIEWED, reason: MERGE_TREE_ONLY, ...result } });
    return { stepResults: { "merge-policy:r0:0:0": { stepId: "merge-policy:r0:0", iteration: 0, output } } } as unknown as WorkflowRun;
  }

  it("reads an authority/MRG-AU gate at the head the prompt names", () => {
    expect(authorityGate(runDeciding({ rule: { table: "authority", rowId: "MRG-AU" } }), PROMPT)).toEqual({ head: REVIEWED, reason: MERGE_TREE_ONLY });
  });

  it.each([
    ["a seat owner-gate", { table: "shepherd-seat", rowId: "trusted-seat" }],
    ["a registration owner-gate, as a Gate 2 visual PR registers", { table: "shepherd-seat", rowId: "none" }],
    ["a Version Packages release gate", { table: "shepherd-release", rowId: "release-merge" }],
    ["a .github/ guard row", { table: "shepherd-merge-guard", rowId: "github-path" }],
    ["a route escalation", { table: "shepherd-route", rowId: "conflict" }],
    ["an authority rule other than MRG-AU", { table: "authority", rowId: "MRG-OT" }],
  ])("leaves %s alone, whatever its reason", (_case, rule) => {
    expect(authorityGate(runDeciding({ rule }), PROMPT)).toBeUndefined();
  });

  it("leaves an MRG-AU gate decided about another head alone", () => {
    expect(authorityGate(runDeciding({ rule: { table: "authority", rowId: "MRG-AU" }, headSha: PUSHED }), PROMPT)).toBeUndefined();
  });
});

describe("transientOnlyConditions", () => {
  const GATES = "MRG-AU gates merge by automation";

  it.each([
    ["merge-tree-clean is the review row's one unmet condition", `${GATES}; MRG-AU-RV unmet: merge-tree-clean; MRG-AU-RC unmet: verdict-merge-carried-tree-equal, merge-tree-clean`, ["merge-tree-clean"]],
    ["a review-rules read closed and left only merge-tree-clean unmet", `${GATES}; MRG-AU-RV unmet: merge-tree-clean; read closed: review rules are unreadable: 502`, ["merge-tree-clean"]],
    ["a freeze is the review row's one unmet condition", `${GATES}; MRG-AU-RV unmet: repo-not-frozen; MRG-AU-RC unmet: verdict-merge-carried-tree-equal, repo-not-frozen`, ["repo-not-frozen"]],
    ["a freeze is the carry row's one unmet condition", `${GATES}; MRG-AU-RV unmet: verdict-merge-at-head, repo-not-frozen; MRG-AU-RC unmet: repo-not-frozen`, ["repo-not-frozen"]],
    ["the review row missed only the merge tree and the freeze", `${GATES}; MRG-AU-RV unmet: merge-tree-clean, repo-not-frozen; MRG-AU-RC unmet: verdict-merge-carried-tree-equal, merge-tree-clean, repo-not-frozen`, ["merge-tree-clean", "repo-not-frozen"]],
    ["a lasting condition is unmet on every row", `${GATES}; MRG-AU-RV unmet: verdict-merge-at-head, repo-not-frozen; MRG-AU-RC unmet: verdict-merge-carried-tree-equal, repo-not-frozen`, []],
    ["merge-tree-clean held and another condition is unmet", `${GATES}; MRG-AU-RV unmet: required-contexts-green`, []],
    ["the request was tainted", `${GATES}; MRG-AU-RV skipped: tainted is not false; MRG-AU-RC skipped: tainted is not false`, []],
  ])("when %s: %s", (_case, reason, expected) => {
    expect(transientOnlyConditions(reason)).toEqual(expected);
  });
});
