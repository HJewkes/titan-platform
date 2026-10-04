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
import { factoryRoutesFor } from "../workflows.js";
import { sleep, step } from "../workflows/land.js";
import { MergeResultResult } from "../workflows/land-steps.js";
import { SHEPHERD_WORKFLOW } from "./commands.js";
import { CLOSED_ELSEWHERE, LANDED_ELSEWHERE, endRunsGoneElsewhere } from "./gone-elsewhere.js";
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
