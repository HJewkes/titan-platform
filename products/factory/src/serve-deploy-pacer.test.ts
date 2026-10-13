import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "./definition.js";
import { ghDeployNow } from "./deploy-pacer-sweep.js";
import { deployPausePath } from "./deploy-pause.js";
import { startFactoryServer, type FactoryServer, type FactoryServerOptions } from "./serve.js";
import { DEPLOY_MAX_WAIT_MS, DEPLOY_NOW_LABEL, DEPLOY_QUIET_MS, nodeWantedStore, noteWanted, writeWanted, type DeployPacerOptions, type WantedStore } from "./shepherd/deploy-pacer.js";
import { landScenario } from "./test-support/land.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;
const WANTED = "c".repeat(40);
const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-pacer-"));
  dirs.push(dir);
  return dir;
}

/** A pacer over a real state dir whose merge was queued at T0, counting the sweep's reads so a test can wait out ticks that spawn nothing. */
function pacerWorld() {
  const stateDir = tempDir();
  writeWanted(stateDir, nodeWantedStore, noteWanted(undefined, WANTED, T0));
  const spawned: string[] = [];
  let reads = 0;
  const store: WantedStore = { ...nodeWantedStore, readFile: (path) => ((reads += 1), nodeWantedStore.readFile(path)) };
  const pacer: DeployPacerOptions = { stateDir, store, sweepMs: 10, spawn: (sha) => (spawned.push(sha), { pid: 4242 }) };
  const clock = { now: T0 };
  const ticks = async (count: number) => {
    const until = reads + count;
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(until));
  };
  return { stateDir, pacer, spawned, clock, ticks };
}

async function serve(world: ReturnType<typeof pacerWorld> | undefined, overrides: Partial<FactoryServerOptions> = {}): Promise<FactoryServer> {
  const scenario = landScenario();
  const server = await startFactoryServer({
    dbPath: join(tempDir(), "factory.sqlite3"),
    workflows: [scenario.workflow],
    routes: scenario.routes,
    now: () => world?.clock.now ?? T0,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "a".repeat(40), behindMain: { status: () => 0, refresh: async () => undefined } },
    ...(world && { deployPacer: world.pacer }),
    ...overrides,
  });
  servers.push(server);
  return server;
}

const HealthBody = z.record(z.string(), z.unknown());
const health = async (server: FactoryServer) => HealthBody.parse(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json());

/** A run parked in a never-ending step, which `/health` lists as busy. */
function busyChore(): Pick<FactoryServerOptions, "workflows" | "routes"> & { reached: Promise<void> } {
  let entered = (): void => undefined;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const routes: StepRoute[] = [{ match: "chore", onRestart: "park", runner: { run: () => (entered(), new Promise(() => undefined)) } }];
  const chore = defineWorkflow({ name: "chore", steps: [{ id: "chore", kind: "dispatch" }], run: async (ctx) => void (await ctx.dispatch("chore", "chore")) });
  return { workflows: [chore], routes, reached };
}

describe("serve's deploy pacer sweep", () => {
  it("spawns the deployer once for a queued sha after the quiet window, and /health shows it pending, then spawned", async () => {
    const world = pacerWorld();
    world.clock.now = T0 + 5 * MIN;
    const server = await serve(world);
    await world.ticks(2);
    const before = await health(server);

    world.clock.now = T0 + DEPLOY_QUIET_MS + MIN;
    await vi.waitFor(() => expect(world.spawned).toEqual([WANTED]));
    await world.ticks(3);
    const after = await health(server);

    expect(before.deployPending).toEqual({ sha: WANTED, since: new Date(T0).toISOString(), deploysBy: new Date(T0 + DEPLOY_MAX_WAIT_MS).toISOString() });
    expect(world.spawned).toEqual([WANTED]);
    expect(after.deployPending).toMatchObject({ sha: WANTED, spawnedSha: WANTED, spawnedAt: new Date(T0 + DEPLOY_QUIET_MS + MIN).toISOString() });
  });

  it("holds the spawn while a run is busy", async () => {
    const world = pacerWorld();
    const chore = busyChore();
    const server = await serve(world, { workflows: chore.workflows, routes: chore.routes });
    server.host.runtime.start("chore");
    await chore.reached;

    world.clock.now = T0 + DEPLOY_QUIET_MS + MIN;
    await world.ticks(3);

    expect((await health(server)).busy).toHaveLength(1);
    expect(world.spawned).toEqual([]);
  });

  it("never spawns while TP-2268's deploy pause is on disk, even past the cap", async () => {
    const world = pacerWorld();
    writeFileSync(deployPausePath(world.stateDir), "{}\n");
    world.clock.now = T0 + DEPLOY_MAX_WAIT_MS + MIN;
    await serve(world);

    await world.ticks(3);

    expect(world.spawned).toEqual([]);
  });

  it("clears a wanted sha the running build descends from instead of spawning a deployer, and /health shows none pending", async () => {
    const world = pacerWorld();
    world.clock.now = T0 + DEPLOY_MAX_WAIT_MS + MIN;
    const server = await serve({ ...world, pacer: { ...world.pacer, isAncestor: async (ancestor) => ancestor === WANTED } });

    await vi.waitFor(async () => expect((await health(server)).deployPending).toBeNull());

    expect(world.spawned).toEqual([]);
  });

  it(`spawns a ${DEPLOY_NOW_LABEL} sha inside the quiet window`, async () => {
    const world = pacerWorld();
    world.clock.now = T0 + MIN;

    await serve({ ...world, pacer: { ...world.pacer, express: async (sha) => sha === WANTED } });

    await vi.waitFor(() => expect(world.spawned).toEqual([WANTED]));
  });

  it(`holds a ${DEPLOY_NOW_LABEL} sha while a run is busy`, async () => {
    const world = pacerWorld();
    world.clock.now = T0 + MIN;
    const label = { on: false };
    const chore = busyChore();
    const server = await serve({ ...world, pacer: { ...world.pacer, express: async () => label.on } }, { workflows: chore.workflows, routes: chore.routes });
    server.host.runtime.start("chore");
    await chore.reached;

    label.on = true;
    await world.ticks(3);

    expect(world.spawned).toEqual([]);
  });

  it("without a deploy pacer, /health has no deployPending", async () => {
    const server = await serve(undefined);

    expect(await health(server)).not.toHaveProperty("deployPending");
  });
});

describe(`the ${DEPLOY_NOW_LABEL} probe`, () => {
  const answer = (code: number, stdout: string) => async () => ({ code, stdout, stderr: "" });

  it("asks GitHub for the labels of the PRs merged as the sha", async () => {
    const calls: string[][] = [];
    const probe = ghDeployNow("o/r", async (file, args) => (calls.push([file, ...args]), { code: 0, stdout: `["bug","${DEPLOY_NOW_LABEL}"]\n`, stderr: "" }));

    const found = await probe("abc");

    expect(found).toBe(true);
    expect(calls).toEqual([["gh", "api", "repos/o/r/commits/abc/pulls", "--jq", "[.[].labels[].name]"]]);
  });

  it.each([
    ["no such label", answer(0, '["bug"]')],
    ["a gh failure", answer(1, "")],
    ["gh missing", async () => undefined],
    ["unparseable output", answer(0, "not json")],
  ])("reads %s as unlabelled", async (_, run) => {
    expect(await ghDeployNow("o/r", run)("abc")).toBe(false);
  });

  it("remembers a label once found, and asks again after a miss", async () => {
    const replies = ['["bug"]', `["${DEPLOY_NOW_LABEL}"]`];
    let calls = 0;
    const probe = ghDeployNow("o/r", async () => ({ code: 0, stdout: replies[Math.min(calls++, 1)]!, stderr: "" }));

    const answers = [await probe("abc"), await probe("abc"), await probe("abc")];

    expect(answers).toEqual([false, true, true]);
    expect(calls).toBe(2);
  });
});
