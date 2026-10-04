import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
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
import { CLOSED_ELSEWHERE, LANDED_ELSEWHERE, endRunsGoneElsewhere, mergedByShepherd } from "./gone-elsewhere.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ORPHANED, resyncShepherd } from "./resync.js";
import { shepherdStoreRef } from "./store.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const SEED_LEASE_MS = 3_000;
const AFTER_LEASE = T0 + 60_000;
const HEAD = fakeSha("resync-head");
const AWAIT_VERDICT = "sh-await-verdict";
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

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
    if (TERMINAL.has(run.status)) return run;
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
  it("still reports the runs it ended and the error", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    merge(w.fake, 1);
    const routes = w.freshRoutes();
    const host = openFactoryHost({ dbPath: w.dbPath, workflows: w.workflows, routes, now: () => AFTER_LEASE, gatePollMs: 10 });
    cleanups.push(() => host.close());
    const services = routes.shepherd!;
    const broken: FactoryHost = Object.assign(Object.create(host) as FactoryHost, {
      pendingGates: () => {
        throw new Error("gate store down");
      },
    });

    const report = await resyncShepherd(broken, services);

    expect(report.ended.map((ended) => ended.runId)).toEqual([runId]);
    expect(report.supersedeError).toBe("gate store down");
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
    expect(out).toBe(`run ${runId.slice(0, 8)} would end: ${LANDED_ELSEWHERE}${REPO}#1 was merged outside Shepherd\nwould cancel 0 orphaned gate(s); would supersede 0 moved-head gate(s)\n`);
    expect(w.seed.runtime.status(runId)?.status).toBe("paused");
    expect(w.seed.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });
});

describe("recheck before adoption", () => {
  const LEASE_MS = 40;

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
    /** getPr rejects for PR 1 only, while `unreadable.value` is set. */
    function flakyRoutes(w: World, unreadable: { value: boolean }): FactoryRoutes {
      const fresh = w.freshRoutes();
      const getPr = fresh.shepherd!.port.getPr.bind(fresh.shepherd!.port);
      const port = { ...fresh.shepherd!.port, getPr: async (repo: string, pr: number) => (unreadable.value && pr === 1 ? Promise.reject(new Error("rate limited")) : getPr(repo, pr)) };
      return Object.assign([...fresh], { database: fresh.database, shepherd: { ...fresh.shepherd!, port } });
    }

    async function twoHeldRuns(unreadable: { value: boolean }) {
      const w = world({ hangAt: "land-rules" });
      const runs = [await stuckRun(w, 1, "land-rules"), await stuckRun(w, 2, "land-rules")] as const;
      const now = { value: T0 + 1_000 };
      const server = await serve(w, { now: () => now.value, leaseMs: LEASE_MS, routes: flakyRoutes(w, unreadable) });
      now.value = AFTER_LEASE;
      await gateOpened(server.host, gateId(runs[1], "approve-merge"));
      return { w, server, runs };
    }

    it("is neither adopted nor driven while another run in the same tick is, then adopted once the read succeeds", async () => {
      const unreadable = { value: true };
      const { server, runs } = await twoHeldRuns(unreadable);
      await sleep(3 * LEASE_MS, new AbortController().signal);

      expect(server.host.gates.get(gateId(runs[0], "approve-merge"))).toBeUndefined();
      expect(server.host.runtime.status(runs[0])?.status).toBe("running");

      unreadable.value = false;
      await gateOpened(server.host, gateId(runs[0], "approve-merge"));
      expect(server.host.runtime.status(runs[0])?.status).toBe("paused");
    });

    it("is ended, never driven, when a later read finds its PR merged", async () => {
      const unreadable = { value: true };
      const { w, server, runs } = await twoHeldRuns(unreadable);
      await sleep(3 * LEASE_MS, new AbortController().signal);
      merge(w.fake, 1);
      unreadable.value = false;
      const run = await settled(server.host, runs[0]);

      expect(run.status).toBe("cancelled");
      expect(run.error?.startsWith(LANDED_ELSEWHERE)).toBe(true);
      expect(never(run)).toEqual([]);
    });
  });

  it("a skipped run whose PR is still open is adopted and driven as before", async () => {
    const w = world();
    const runId = await gatedRun(w, 1);
    const now = { value: T0 + 1_000 };

    const server = await crashRestart(w, now);
    now.value = AFTER_LEASE;
    await gateOpened(server.host, gateId(runId, "approve-merge"));
    await sleep(3 * LEASE_MS, new AbortController().signal);

    expect(server.host.runtime.status(runId)?.status).toBe("paused");
    expect(server.host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });
});
