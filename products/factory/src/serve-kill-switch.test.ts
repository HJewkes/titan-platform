import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { configPath } from "./config.js";
import { sourcesReader } from "./github-sources/mode.js";
import { DUE_CHECK_TICK_MS } from "./github-sources/schedule.js";
import { webhookSecretPath } from "./ingress/paths.js";
import { REPO, fakeBotIdentity, rig } from "./reconciler/fakes.test-helpers.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { statusDelivery } from "./test-support/a17/ci-shapes.js";
import { landScenario } from "./test-support/land.js";

const SECRET = "5e".repeat(32);
const MINUTE = 60_000;
const POLLING_MS = MINUTE;
const BACKSTOP_MS = 10 * MINUTE;
const T0 = Date.parse("2027-01-15T08:00:00.000Z");

let dir: string;
let server: FactoryServer | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dir = mkdtempSync(join(tmpdir(), "factory-kill-switch-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

interface Deployment {
  env: NodeJS.ProcessEnv;
  setIngress(ingress: "on" | "off"): void;
}

function deployment(): Deployment {
  const env = { XDG_CONFIG_HOME: dir };
  mkdirSync(dirname(webhookSecretPath(env)), { recursive: true, mode: 0o700 });
  writeFileSync(webhookSecretPath(env), `${SECRET}\n`, { mode: 0o600 });
  const setIngress = (ingress: "on" | "off") =>
    writeFileSync(configPath(env), JSON.stringify({ github: { sources: "webhook", ingress, pollingIntervalMs: POLLING_MS, backstopIntervalMs: BACKSTOP_MS } }));
  setIngress("on");
  return { env, setIngress };
}

function deliver(port: number): Promise<Response> {
  const body = JSON.stringify(statusDelivery({ type: "status", repo: REPO, head: "e".repeat(40), context: `ci-${randomUUID()}`, outcome: "success", at: "2027-01-15T07:00:00Z" }));
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const headers = { "content-type": "application/json", "x-github-event": "status", "x-github-delivery": randomUUID(), "x-hub-signature-256": signature };
  return fetch(`http://127.0.0.1:${port}/ingress/github`, { method: "POST", headers, body });
}

async function ingressPort(started: FactoryServer): Promise<number> {
  const health: unknown = await (await fetch(`http://127.0.0.1:${started.port}/health`)).json();
  return z.object({ ingress: z.object({ port: z.number() }) }).parse(health).ingress.port;
}

const webhookRows = (started: FactoryServer) => started.host.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM factory_event WHERE source = 'webhook'").get()?.n ?? 0;

interface Running {
  started: FactoryServer;
  port: number;
  /** Fake-clock offsets from T0 at which a reconciler pass read the snapshot. */
  passes: number[];
  /** Moves the fake clock and the schedule's interval together, one due-check tick at a time. */
  advance(ms: number): Promise<void>;
}

/** Real serve over the reconciler rig's fake GitHub, with the ingress bound and the config file's sources in force. */
async function startServe(env: NodeJS.ProcessEnv): Promise<Running> {
  const r = rig();
  let clock = T0;
  const passes: number[] = [];
  const send = r.github.send.bind(r.github);
  r.github.send = (call) => (call.kind === "snapshot" && passes.push(clock - T0), send(call));
  const scenario = landScenario();
  const started = (server = await startFactoryServer({
    dbPath: join(dir, "state", "factory.sqlite3"),
    workflows: [scenario.workflow],
    routes: scenario.routes,
    port: 0,
    now: () => clock,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    sources: sourcesReader(env),
    ingress: { port: 0, secretPath: webhookSecretPath(env) },
    bot: () => fakeBotIdentity(),
    reconciler: { config: { enabled: true, intervalMs: 5 * MINUTE, fullEvery: 3, repos: [REPO] }, ports: () => r.bot },
  }));
  const advance = async (ms: number) => {
    for (let step = 0; step < ms / DUE_CHECK_TICK_MS; step += 1) {
      clock += DUE_CHECK_TICK_MS;
      await vi.advanceTimersByTimeAsync(DUE_CHECK_TICK_MS);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { started, port: await ingressPort(started), passes, advance };
}

describe("serve's ingress kill switch end to end (TP-3099 I5)", () => {
  // Mutations killed: the schedule's mode-change branch dropped (no catch-up pass); the route's mode check removed (off answers 200).
  it("flips off and back on through the config file, with no restart: the route answers 404 then 2xx and the reconciler changes cadence", async () => {
    const { env, setIngress } = deployment();
    const { started, port, passes, advance } = await startServe(env);
    await vi.waitFor(() => expect(passes).toEqual([0]));
    passes.splice(0);

    const on = await deliver(port);
    setIngress("off");
    const off = await deliver(port);
    await advance(2 * MINUTE + DUE_CHECK_TICK_MS);
    const pollingPasses = passes.splice(0);

    setIngress("on");
    const back = await deliver(port);
    await advance(BACKSTOP_MS + DUE_CHECK_TICK_MS);

    expect([on.status, off.status, back.status]).toEqual([200, 404, 200]);
    expect(await off.json()).toEqual({ error: "ingress off" });
    expect(webhookRows(started)).toBe(2);
    expect(pollingPasses).toEqual([DUE_CHECK_TICK_MS, DUE_CHECK_TICK_MS + POLLING_MS, DUE_CHECK_TICK_MS + 2 * POLLING_MS]);
    expect(passes).toEqual([150_000, 150_000 + BACKSTOP_MS]);
  });
});
