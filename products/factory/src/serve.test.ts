import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AnswersPage, AskRequest } from "@titan-design/agent-dispatch";
import { memoryPoolStateStore } from "@titan-design/github";
import { DaemonAlreadyRunningError, silentLogger } from "@titan-design/daemon";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toJSONSchema, z } from "zod";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { defineWorkflow } from "./definition.js";
import { approveMergeDecision } from "./gate-brief.js";
import { configPath } from "./config.js";
import { githubApiStatus } from "./github-api/status.js";
import { resolveSources, sourcesReader } from "./github-sources/mode.js";
import { webhookSecretPath } from "./ingress/paths.js";
import type { GateNotifyOptions } from "./gate-notify-sweep.js";
import { sqliteReconcilerCursor } from "./reconciler/cursor.js";
import { OTHER_REPO, REPO, fakeBotIdentity, rig } from "./reconciler/fakes.test-helpers.js";
import { serveFactoryUntilSignal, startFactoryServer, sweepCheckouts, type FactoryServer, type FactoryServerOptions } from "./serve.js";
import { statusDelivery } from "./test-support/a17/ci-shapes.js";
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

const healthOf = async (server: FactoryServer): Promise<Record<string, unknown>> => {
  const body: unknown = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
  if (!isObjectLike(body)) throw new Error("/health answered no object");
  return body;
};

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

    const health = await healthOf(server);

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

    const health = await healthOf(server);

    expect(health.busy).toEqual([{ runId, step: "chore", phase: "park" }]);
  });

  it("health reports the snapshot tick and that it slowed under a low rate limit", async () => {
    const scenario = landScenario();
    const pacing = { tickMs: () => 300_000, status: () => ({ tickMs: 300_000, slowed: true, remaining: 900 }) };
    Object.assign(scenario.routes, { shepherd: { pacing } });
    const server = await serve(dbFile(), scenario);

    const health = await healthOf(server);

    expect(health.snapshotTick).toEqual({ tickMs: 300_000, slowed: true, remaining: 900 });
  });

  it("health carries the github probe result", async () => {
    const server = await serve(dbFile(), landScenario(), { github: { status: () => "gh: HTTP 401", refresh: async () => undefined } });

    const health = await healthOf(server);

    expect(health.github).toBe("gh: HTTP 401");
  });

  it("health carries the build sha and how far main has moved", async () => {
    const build = { sha: "abc123", behindMain: { status: () => 4, refresh: async () => undefined } };
    const server = await serve(dbFile(), landScenario(), { build });

    const health = await healthOf(server);

    expect(health.build).toEqual({ sha: "abc123", behindMain: 4 });
  });

  it("health shows the github sources in force, and keeps them with a configError once the file turns invalid after start", async () => {
    const xdg = dirname(dirname(dbFile()));
    const file = join(xdg, "titan-factory", "config.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ github: { sources: "webhook", ingress: "off", pollingIntervalMs: 90_000 } }));
    const server = await serve(dbFile(), landScenario(), { sources: sourcesReader({ XDG_CONFIG_HOME: xdg }) });

    const before = await healthOf(server);
    writeFileSync(file, '{ "github": ');
    const after = await healthOf(server);

    expect(before).toHaveProperty("sources", { configured: "webhook", effective: "polling", reason: "kill-switch", intervalMs: 90_000, lastPassAt: null, reconciler: "disabled" });
    expect(after).toHaveProperty("sources", { configured: "webhook", effective: "polling", reason: "kill-switch", intervalMs: 90_000, lastPassAt: null, reconciler: "disabled", configError: expect.stringMatching(/^invalid config /) });
  });

  it("health has no sources field when serve was given no reader", async () => {
    const server = await serve(dbFile(), landScenario());

    expect(await healthOf(server)).not.toHaveProperty("sources");
  });

  it("health shows the github-api pool's state per call class once the bot pool binds it, and no field before", async () => {
    const store = memoryPoolStateStore();
    store.set("example-bot[bot]", "mutation", { state: "closed", resetAt: T0 + 60_000, streak: 1 });
    const bound = await serve(dbFile(), landScenario(), { githubApi: githubApiStatus({ identity: "example-bot[bot]", store, log: () => undefined }).health });
    const unbound = await serve(dbFile(), landScenario());

    expect(await healthOf(bound)).toHaveProperty("githubApi.mutation", { state: "closed", resetAt: new Date(T0 + 60_000).toISOString() });
    expect(await healthOf(unbound)).not.toHaveProperty("githubApi");
  });

  describe("webhook ingress", () => {
    const SECRET = "5e".repeat(32);
    const ingressPort = async (server: FactoryServer) => z.object({ ingress: z.object({ port: z.number() }) }).parse(await healthOf(server)).ingress.port;

    function deliver(port: number): Promise<Response> {
      const body = JSON.stringify(statusDelivery({ type: "status", repo: "acme/widgets", head: "e".repeat(40), context: "ci", outcome: "success", at: "2026-10-20T12:00:00Z" }));
      const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
      const headers = { "content-type": "application/json", "x-github-event": "status", "x-github-delivery": "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b", "x-hub-signature-256": signature };
      return fetch(`http://127.0.0.1:${port}/ingress/github`, { method: "POST", headers, body });
    }

    function tempXdg(): NodeJS.ProcessEnv {
      const env = { XDG_CONFIG_HOME: dirname(dirname(dbFile())) };
      mkdirSync(dirname(webhookSecretPath(env)), { recursive: true, mode: 0o700 });
      writeFileSync(webhookSecretPath(env), `${SECRET}\n`, { mode: 0o600 });
      return env;
    }

    // Mutation killed: the sources read once at listener start instead of on each request.
    it("answers ingress off under the default config, then takes the next signed delivery once the config turns webhook on, with no restart", async () => {
      const env = tempXdg();
      const server = await serve(dbFile(), landScenario(), { sources: sourcesReader(env), ingress: { port: 0, secretPath: webhookSecretPath(env) } });
      const port = await ingressPort(server);

      const off = await deliver(port);
      writeFileSync(configPath(env), JSON.stringify({ github: { sources: "webhook", ingress: "on" } }));
      const on = await deliver(port);

      expect([off.status, await off.json()]).toEqual([404, { error: "ingress off" }]);
      expect([on.status, await on.json()]).toEqual([200, { seq: 1, inserted: true }]);
      expect(await healthOf(server)).toHaveProperty("ingress", expect.objectContaining({ path: "/ingress/github", listening: true, secret: "present", counts: { stored: 1, duplicate: 0, ignored: 0, refused: 1 } }));
    });

    // Mutation killed: the EADDRINUSE let out of startFactoryServer.
    it("keeps serving with the ingress shown as not listening when its port is already taken", async () => {
      const taken = createNetServer();
      await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())));
      const address = taken.address();
      if (address === null || typeof address === "string") throw new Error("not bound to a TCP port");
      const port = address.port;

      const server = await serve(dbFile(), landScenario(), { ingress: { port, secretPath: webhookSecretPath(tempXdg()) } });
      const health = await fetch(`http://127.0.0.1:${server.port}/health`);

      expect(health.status).toBe(200);
      expect(await health.json()).toHaveProperty("ingress", expect.objectContaining({ port, listening: false, error: expect.stringContaining("EADDRINUSE") }));
    });

    it("health has no ingress field when serve was given no ingress", async () => {
      const server = await serve(dbFile(), landScenario());

      expect(await healthOf(server)).not.toHaveProperty("ingress");
    });
  });

  it("health reports an unknown build when none was baked in", async () => {
    const server = await serve(dbFile(), landScenario());

    const health = await healthOf(server);

    expect(health.build).toEqual({ sha: "unknown", behindMain: "unknown" });
  });
});

describe("titan-factory serve start record", () => {
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

describe("serveFactoryUntilSignal beside another serve", () => {
  const options = (dbPath: string, scenario: LandScenario, overrides: Partial<FactoryServerOptions> = {}): FactoryServerOptions => ({
    dbPath,
    workflows: [scenario.workflow],
    routes: scenario.routes,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    ...overrides,
  });
  const stopped = (): AbortSignal => AbortSignal.abort();

  it("a second serve beside a live factory returns without error and leaves it serving", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    const first = await serve(dbPath, scenario);

    await serveFactoryUntilSignal(options(dbPath, scenario), stopped());

    const health = await fetch(`http://127.0.0.1:${first.port}/health`);
    expect(health.ok).toBe(true);
  });

  it("a second serve whose pid file names a process that does not answer as that pid still fails", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    await serve(dbPath, scenario);
    const probe = async () => ({ state: "up" as const, health: { pid: process.pid + 1 } });

    const second = serveFactoryUntilSignal(options(dbPath, scenario, { probe }), stopped());

    await expect(second).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it("a second serve whose live factory refuses the health probe still fails", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    await serve(dbPath, scenario);

    const second = serveFactoryUntilSignal(options(dbPath, scenario, { probe: async () => ({ state: "refused" }) }), stopped());

    await expect(second).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });
});

describe("serve's start-up warnings", () => {
  it("logs a warning when the deploy watch has no hub seat to tell", async () => {
    const warnings: unknown[] = [];
    const logger = { ...silentLogger, warn: (_fields: unknown, msg?: unknown) => void warnings.push(msg) };
    const startupWarning = "shepherd.hubSeat is not set: a deploy alarm reaches no seat";

    await serve(dbFile(), landScenario(), { logger, deployWatch: { tick: async () => undefined, status: () => null, startupWarning } });

    expect(warnings).toContain(startupWarning);
  });
});

describe("serve's reconciler (I9)", () => {
  const config = { enabled: true, intervalMs: 300_000, fullEvery: 3, repos: [REPO, OTHER_REPO] };

  it("returns from start before the forced start pass's first read answers, then snapshots every repo once", async () => {
    const r = rig();
    let release = (): void => undefined;
    r.github.hold = new Promise<void>((resolve) => (release = resolve));

    const server = await serve(dbFile(), landScenario(), { bot: () => fakeBotIdentity(), reconciler: { config, ports: () => r.bot } });
    expect(r.github.calls.length).toBe(1);

    release();
    const cursor = sqliteReconcilerCursor(server.host.db);
    await vi.waitFor(() => expect(cursor.read(OTHER_REPO).main?.value).toBe("c1"));
    expect([r.github.count("snapshot", REPO), r.github.count("snapshot", OTHER_REPO)]).toEqual([1, 1]);
  });

  it("reads serve's sources for its cadence, so a kill-switched webhook deployment runs at the polling interval", async () => {
    const started: unknown[] = [];
    const logger = { ...silentLogger, info: (fields: unknown, msg?: unknown) => void (msg === "reconciler.started" && started.push(fields)) };
    const sources = () => resolveSources({ github: { sources: "webhook", ingress: "off", pollingIntervalMs: 45_000 } });

    await serve(dbFile(), landScenario(), { logger, sources, bot: () => fakeBotIdentity(), reconciler: { config, ports: () => rig().bot } });

    expect(started).toEqual([{ repos: [REPO, OTHER_REPO], effective: "polling", reason: "kill-switch", intervalMs: 45_000 }]);
  });

  it("health shows the start pass in sources.lastPassAt, with the interval the schedule runs at", async () => {
    const sources = () => resolveSources({ github: { sources: "webhook", ingress: "off", pollingIntervalMs: 45_000 } });
    const server = await serve(dbFile(), landScenario(), { sources, bot: () => fakeBotIdentity(), reconciler: { config, ports: () => rig().bot } });

    await vi.waitFor(async () => expect(await healthOf(server)).toHaveProperty("sources", expect.objectContaining({ intervalMs: 45_000, lastPassAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })));
  });

  it("starts no reconciler while reconciler.enabled is off", async () => {
    const r = rig();

    await serve(dbFile(), landScenario(), { bot: () => fakeBotIdentity(), reconciler: { config: { ...config, enabled: false }, ports: () => r.bot } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.github.calls).toEqual([]);
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
      list: async (dir) => (dir === root ? ["review-7-0123456789ab"] : []),
      stat: async () => ({ isDirectory: true, mtimeMs: 0 }),
      remove: async () => {
        throw new Error("EBUSY");
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toEqual({ path, err: "EBUSY" });
  });
});

describe("serve's gate notifier", () => {
  const HEAD = "b".repeat(40);

  /** One question per ask, answered from `replies` by msg id. */
  function fakeQueue(replies: Record<string, string> = {}) {
    const asked: AskRequest[] = [];
    let reads = 0;
    const read = (): AnswersPage => {
      reads += 1;
      const answers = Object.entries(replies).map(([questionId, text], i) => ({ msgId: `a${i}`, questionId, outcome: "answered" as const, text, by: "human" as const, channel: "phone", at: i }));
      return { answers, ...(answers.length > 0 && { next: answers.at(-1)!.msgId }) };
    };
    const options: GateNotifyOptions = {
      label: "titan-factory",
      resolverClass: "owner-remote",
      askHuman: async (req) => `q${asked.push(req)}`,
      readAnswers: async () => read(),
      dismissAsk: async () => undefined,
    };
    return { options, asked, reads: () => reads };
  }

  /** `unpinned` leaves the head free in the schema, so no answer can supply it and the gate stays off the phone. */
  function openMergeGate(server: FactoryServer, id: string, { unpinned = false } = {}): void {
    const { schema, brief } = approveMergeDecision({ repo: "HJewkes/demo", pr: 7, headSha: HEAD, reason: "Ready.", reviewedMerge: true });
    const json = toJSONSchema(schema);
    const gateSchema = unpinned ? { ...json, properties: { ...json.properties, headSha: { type: "string" as const } } } : json;
    server.host.gates.create({ id, prompt: "Merge?", schema: gateSchema, ...brief });
  }

  const health = async (server: FactoryServer): Promise<unknown> => (await fetch(`http://127.0.0.1:${server.port}/health`)).json();

  it("asks nothing and shows no gateNotify block without the config", async () => {
    const server = await serve(dbFile(), landScenario(), {});
    openMergeGate(server, "run1/approve-merge");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.host.asks.get("run1/approve-merge")).toBeUndefined();
    expect(await health(server)).not.toHaveProperty("gateNotify");
  });

  it("asks a pending decision gate once, and close stops the sweep", async () => {
    const queue = fakeQueue();
    const errors: unknown[] = [];
    const logger = { ...silentLogger, error: (_fields: unknown, msg?: unknown) => void errors.push(msg) };
    const server = await serve(dbFile(), landScenario(), { logger, gateNotify: { ...queue.options, everyMs: 10 } });
    openMergeGate(server, "run1/approve-merge");

    await vi.waitFor(() => expect(queue.reads()).toBeGreaterThan(2));
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queue.asked).toEqual([expect.objectContaining({ as: "titan-factory", task: "gate:run1/approve-merge" })]);
    expect(errors).not.toContain("gate notify failed");
  });

  it("health shows a gate whose answer could not settle it and a gate no answer can settle", async () => {
    const queue = fakeQueue({ q1: "maybe" });
    const server = await serve(dbFile(), landScenario(), { gateNotify: { ...queue.options, everyMs: 10 } });
    openMergeGate(server, "run1/approve-merge");
    openMergeGate(server, "run2/approve-merge", { unpinned: true });

    await vi.waitFor(() => expect(server.host.asks.get("run1/approve-merge")?.state).toBe("unmappable"));

    expect(await health(server)).toMatchObject({
      gateNotify: { label: "titan-factory", resolverClass: "owner-remote", open: 0, stuck: [{ gateId: "run1/approve-merge", state: "unmappable", detail: "maybe" }], unasked: ["run2/approve-merge"] },
    });
  });

  it("health names the error while the label's answers cannot be read", async () => {
    const queue = fakeQueue();
    const options = { ...queue.options, readAnswers: async () => Promise.reject(new Error("broker unavailable")) };
    const server = await serve(dbFile(), landScenario(), { gateNotify: { ...options, everyMs: 10 } });

    await vi.waitFor(async () => expect(await health(server)).toMatchObject({ gateNotify: { answersError: "broker unavailable" } }));
  });
});
