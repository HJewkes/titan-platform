import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonAlreadyRunningError, silentLogger } from "@titan-design/daemon";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "./definition.js";
import { serveFactoryUntilSignal, startFactoryServer, sweepCheckouts, type FactoryServer, type FactoryServerOptions } from "./serve.js";
import { crashAt } from "./test-support/crash.js";
import { approveUntilSettled, gateId, gateOpened, landScenario, type LandScenario } from "./test-support/land.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-serve-"));
  dirs.push(dir);
  return join(dir, "state", "factory.sqlite3");
}

async function serve(dbPath: string, scenario: LandScenario, overrides: Partial<FactoryServerOptions> = {}): Promise<FactoryServer> {
  const server = await startFactoryServer({
    dbPath,
    workflows: [scenario.workflow],
    routes: scenario.routes,
    now: () => T0,
    gatePollMs: 10,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    ...overrides,
  });
  cleanups.push(() => server.close());
  return server;
}

describe("titan-factory serve", () => {
  it("a run started on one server completes on the next server once the first closes", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    const first = await serve(dbPath, scenario);
    const runId = first.host.runtime.start("land-test");
    await gateOpened(first.host, gateId(runId, "approve-merge"));

    await first.close();
    const second = await serve(dbPath, scenario);
    await approveUntilSettled(second.host, runId, scenario.fake);

    expect(second.host.runtime.status(runId)?.status).toBe("completed");
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged" });
    expect(scenario.fake.effects.merge).toBe(1);
  });

  it("the sweep adopts a run whose owner died once its lease lapses, after the start-up adoption missed it", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    const crash = crashAt({ dbPath, workflows: [scenario.workflow], routes: scenario.routes, hangAt: "land-rules" });
    cleanups.push(() => crash.dispose());
    const runId = crash.crashed.runtime.start("land-test");
    await crash.reached;
    const deadLease = crash.crashed.runtime.status(runId)?.owner?.leaseUntil ?? "";
    let clock = Date.parse(deadLease) - 1;

    const server = await serve(dbPath, scenario, { now: () => clock, leaseMs: 50 });
    const atStart = server.host.runtime.status(runId)?.owner?.leaseUntil;
    clock = Date.parse(deadLease) + 1;
    await approveUntilSettled(server.host, runId, scenario.fake);

    expect(atStart).toBe(deadLease);
    expect(server.host.runtime.status(runId)?.status).toBe("completed");
    expect(scenario.fake.effects.merge).toBe(1);
  });

  it("a second server on the same state directory refuses to start and leaves the first serving", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    const first = await serve(dbPath, scenario);

    const second = serve(dbPath, scenario);

    await expect(second).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    const health = await fetch(`http://127.0.0.1:${first.port}/health`);
    expect(health.ok).toBe(true);
  });

  it("health reports run counts by status and the pending gates", async () => {
    const scenario = landScenario();
    const server = await serve(dbFile(), scenario);
    const runId = server.host.runtime.start("land-test");
    await gateOpened(server.host, gateId(runId, "approve-merge"));

    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Record<string, unknown>;

    expect(health).toMatchObject({ ok: true, runs: { paused: 1, completed: 0 }, pendingGates: 1, busy: [] });
  });

  it("health lists a run held in a park-routed step as busy", async () => {
    let entered = (): void => undefined;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const routes: StepRoute[] = [{ match: "chore", onRestart: "park", runner: { run: () => (entered(), new Promise(() => undefined)) } }];
    const chore = defineWorkflow({ name: "chore", steps: [{ id: "chore", kind: "dispatch" }], run: async (ctx) => void (await ctx.dispatch("chore", "chore")) });
    const server = await serve(dbFile(), landScenario(), { workflows: [chore], routes });
    const runId = server.host.runtime.start("chore");
    await reached;

    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Record<string, unknown>;

    expect(health.busy).toEqual([{ runId, step: "chore", phase: "park" }]);
  });

  it("health reports the snapshot tick and that it slowed under a low rate limit", async () => {
    const scenario = landScenario();
    const pacing = { tickMs: () => 300_000, status: () => ({ tickMs: 300_000, slowed: true, remaining: 900 }) };
    Object.assign(scenario.routes, { shepherd: { pacing } as never });
    const server = await serve(dbFile(), scenario);

    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Record<string, unknown>;

    expect(health.snapshotTick).toEqual({ tickMs: 300_000, slowed: true, remaining: 900 });
  });

  it("health carries the github probe result", async () => {
    const server = await serve(dbFile(), landScenario(), { github: { status: () => "gh: HTTP 401", refresh: async () => undefined } });

    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Record<string, unknown>;

    expect(health.github).toBe("gh: HTTP 401");
  });

  it("health carries the build sha and how far main has moved", async () => {
    const build = { sha: "abc123", behindMain: { status: () => 4, refresh: async () => undefined } };
    const server = await serve(dbFile(), landScenario(), { build });

    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Record<string, unknown>;

    expect(health.build).toEqual({ sha: "abc123", behindMain: 4 });
  });

  it("health reports an unknown build when none was baked in", async () => {
    const server = await serve(dbFile(), landScenario());

    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Record<string, unknown>;

    expect(health.build).toEqual({ sha: "unknown", behindMain: "unknown" });
  });
});

describe("titan-factory serve start record", () => {
  const healthOf = async (server: FactoryServer): Promise<Record<string, unknown>> => (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Record<string, unknown>;

  it("health reports when serve started, its uptime and the start counts beside the fields it had", async () => {
    let clock = Date.parse("2026-10-08T21:00:00.000Z");
    const server = await serve(dbFile(), landScenario(), { now: () => clock });
    clock += 90_000;

    const health = await healthOf(server);

    expect(health).toMatchObject({ ok: true, pendingGates: 0, startedAt: "2026-10-08T21:00:00.000Z", uptimeSeconds: 90, restartCount: 1, uncleanStartsTotal: 0, restartsToday: 1 });
  });

  it("a second start after one left a stale pid file counts a restart and an unclean start", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    const now = () => Date.parse("2026-10-08T21:00:00.000Z");
    await (await serve(dbPath, scenario, { now })).close();
    writeFileSync(join(dirname(dbPath), "daemon.pid"), "999999999\n");

    const second = await serve(dbPath, scenario, { now });

    expect(await healthOf(second)).toMatchObject({ restartCount: 2, uncleanStartsTotal: 1, restartsToday: 2 });
  });

  it("a start refused because a server already runs is not counted", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    const first = await serve(dbPath, scenario);

    await expect(serve(dbPath, scenario)).rejects.toBeInstanceOf(DaemonAlreadyRunningError);

    expect(await healthOf(first)).toMatchObject({ restartCount: 1, uncleanStartsTotal: 0 });
  });
});

describe("titan-factory serve state directory", () => {
  it("refuses an in-memory database without a state directory instead of writing state into the working directory", async () => {
    const scenario = landScenario();

    const start = startFactoryServer({ dbPath: ":memory:", workflows: [scenario.workflow], routes: scenario.routes, port: 0, logger: silentLogger });

    await expect(start).rejects.toThrow(/needs a stateDir/);
    expect(existsSync(join(process.cwd(), "serve-starts.json"))).toBe(false);
    expect(existsSync(join(process.cwd(), "daemon.pid"))).toBe(false);
  });

  it("writes the start record under the given state directory for an in-memory database", async () => {
    const stateDir = dirname(dbFile());
    mkdirSync(stateDir, { recursive: true });

    await serve(":memory:", landScenario(), { stateDir });

    expect(existsSync(join(stateDir, "serve-starts.json"))).toBe(true);
  });
});

describe("serveFactoryUntilSignal", () => {
  it("stamps each serve log line with an ISO time until it shuts down", async () => {
    const lines: unknown[][] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args));
    cleanups.push(() => error.mockRestore());
    const stop = new AbortController();
    const scenario = landScenario();

    const served = serveFactoryUntilSignal({ dbPath: dbFile(), workflows: [scenario.workflow], routes: scenario.routes, port: 0, github: { status: () => "ok", refresh: async () => undefined } }, stop.signal);
    await vi.waitFor(() => expect(lines.some(([line]) => String(line).includes("daemon started"))).toBe(true));
    stop.abort();
    await served;
    console.error("after");

    expect(lines.find(([line]) => String(line).includes("daemon started"))?.[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[info\] daemon started /);
    expect(lines.at(-1)).toEqual(["after"]);
  });
});

describe("sweepCheckouts", () => {
  it("logs a warning naming the path and message when a checkout cannot be removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-sweep-"));
    dirs.push(root);
    const path = join(root, "review-7-0123456789ab");
    const warnings: Array<{ obj: unknown; msg: unknown }> = [];
    const log = { ...silentLogger, warn: (obj: unknown, msg?: unknown) => warnings.push({ obj, msg }) };

    await sweepCheckouts(log, {
      root,
      now: () => T0,
      list: async () => ["review-7-0123456789ab"],
      stat: async () => ({ isDirectory: true, mtimeMs: 0 }),
      remove: async () => {
        throw new Error("EBUSY");
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toEqual({ path, err: "EBUSY" });
  });
});
