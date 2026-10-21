import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "@titan-design/daemon";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { eventLogMigration } from "../event-log/event-log.js";
import { resolveSources } from "../github-sources/mode.js";
import type { Projector } from "./answer.js";
import { listenIngress, type IngressListener, type IngressListenerOptions } from "./listen.js";
import { trackWebhookSecret } from "./secret.js";
import { signDelivery } from "./signature.js";

const SECRET = "a1".repeat(32);
const GUID = "0b9a1f6e-3c2d-4e5f-8a7b-6c5d4e3f2a1b";
const SHA = "d".repeat(40);
const FUNNEL_HOST = "box.example-tailnet.ts.net";
const ON = () => resolveSources({ github: { sources: "webhook", ingress: "on" } });

const project: Projector = (event) =>
  event === "status"
    ? { rule: "identity", kind: "CIConcluded", repo: "o/r", subject: `o/r@${SHA}`, keys: { context: "build" }, occurrenceKey: `v1|CIConcluded|o/r|status|${SHA}|build|success`, payload: { projected: true } }
    : "ignored";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function memoryDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [eventLogMigration()]);
  cleanups.push(() => void db.close());
  return db;
}

async function listen(overrides: Partial<IngressListenerOptions> = {}): Promise<IngressListener & { db: Db }> {
  const db = overrides.db ?? memoryDb();
  const listener = await listenIngress({ port: 0, sources: ON, secret: { read: () => SECRET, state: () => "present" }, project, db, log: silentLogger, ...overrides });
  cleanups.push(() => listener.close());
  return Object.assign(listener, { db });
}

interface Reply {
  status: number;
  body: unknown;
}

const BODY = Buffer.from(JSON.stringify({ state: "success" }));

function signedHeaders(body: Buffer, event = "status"): Record<string, string> {
  return { "content-type": "application/json", "x-github-event": event, "x-github-delivery": GUID, "x-hub-signature-256": signDelivery(SECRET, body) };
}

/** node:http, not fetch: fetch forbids setting Host. */
function send(port: number, method: string, path: string, headers: IncomingHttpHeaders, body?: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(body && { "content-length": String(body.length) }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as unknown }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function portOf(address: AddressInfo | string | null): number {
  if (address === null || typeof address === "string") throw new Error("not bound to a TCP port");
  return address.port;
}

const rowCount = (db: Db) => db.prepare<[], { n: number }>("SELECT count(*) AS n FROM factory_event").get()?.n;

describe("ingress listener routing", () => {
  // Mutation killed: the handler mounted through the daemon's mountRoutes on 7410, whose Host and Origin guards answer 403.
  it("stores a signed delivery sent with the Funnel Host and no Origin or client header", async () => {
    const listener = await listen();

    const reply = await send(listener.port, "POST", "/ingress/github", { ...signedHeaders(BODY), host: FUNNEL_HOST }, BODY);

    expect(reply).toEqual({ status: 200, body: { seq: 1, inserted: true } });
    expect(rowCount(listener.db)).toBe(1);
  });

  // Mutation killed: the path matched with startsWith(INGRESS_PATH).
  it.each([
    ["GET", "/health"],
    ["POST", "/rpc"],
    ["POST", "/ingress/github/x"],
  ])("answers %s %s with 404 and writes nothing", async (method, path) => {
    const listener = await listen();

    const reply = await send(listener.port, method, path, signedHeaders(BODY), BODY);

    expect(reply).toEqual({ status: 404, body: { error: "not found" } });
    expect(rowCount(listener.db)).toBe(0);
  });

  it("answers 404 ingress off while the switch is off", async () => {
    const listener = await listen({ sources: () => resolveSources({}) });

    const reply = await send(listener.port, "POST", "/ingress/github", signedHeaders(BODY), BODY);

    expect(reply).toEqual({ status: 404, body: { error: "ingress off" } });
  });

  it("answers 413 for a body over the cap without storing it", async () => {
    const listener = await listen();
    const big = Buffer.alloc(1024 * 1024 + 1, 0x20);

    const reply = await send(listener.port, "POST", "/ingress/github", signedHeaders(big), big);

    expect(reply.status).toBe(413);
    expect(rowCount(listener.db)).toBe(0);
  });
});

describe("ingress listener timeouts", () => {
  // Mutation killed: requestTimeout dropped, so the stalled socket stays open past the deadline.
  it("cuts a sender that stalls halfway through its body within the request timeout and writes nothing", async () => {
    const listener = await listen({ requestTimeoutMs: 200 });
    const socket = connect(listener.port, "127.0.0.1");
    cleanups.push(() => void socket.destroy());
    const head = Object.entries({ ...signedHeaders(BODY), host: "127.0.0.1", "content-length": String(BODY.length) }).map(([name, value]) => `${name}: ${value}`);
    const started = Date.now();

    socket.write(`POST /ingress/github HTTP/1.1\r\n${head.join("\r\n")}\r\n\r\n${BODY.subarray(0, BODY.length / 2).toString("utf8")}`);
    await new Promise<void>((resolve) => socket.once("close", () => resolve()).resume());

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(rowCount(listener.db)).toBe(0);
  });
});

describe("ingress listener health", () => {
  it("counts stored, duplicate, ignored and refused deliveries and keeps the last one", async () => {
    const listener = await listen();
    const ping = Buffer.from("{}");

    await send(listener.port, "POST", "/ingress/github", signedHeaders(BODY), BODY);
    await send(listener.port, "POST", "/ingress/github", signedHeaders(BODY), BODY);
    await send(listener.port, "POST", "/ingress/github", signedHeaders(ping, "ping"), ping);
    await send(listener.port, "POST", "/ingress/github", { ...signedHeaders(BODY), "x-hub-signature-256": "sha256=00" }, BODY);

    expect(listener.status()).toMatchObject({
      path: "/ingress/github",
      port: listener.port,
      listening: true,
      counts: { stored: 1, duplicate: 1, ignored: 1, refused: 1 },
      lastDelivery: { event: "status", status: 401, at: expect.any(String) },
    });
  });

  // Mutation killed: the EADDRINUSE thrown out of listenIngress instead of reported.
  it("reports a port already taken as not listening instead of throwing", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())));
    const port = portOf(taken.address());

    const listener = await listen({ port });

    expect(listener.status()).toMatchObject({ port, listening: false, error: expect.stringContaining("EADDRINUSE") });
  });
});

describe("webhook secret file", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function secretFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "factory-ingress-secret-"));
    dirs.push(dir);
    return join(dir, "github-webhook.token");
  }

  it("is unread until asked, missing while absent, then present once written with no restart", () => {
    const file = secretFile();
    const secret = trackWebhookSecret(file);
    const before = secret.state();

    expect(() => secret.read()).toThrow();
    const missing = secret.state();
    writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });

    expect(secret.read()).toBe(SECRET);
    expect([before, missing, secret.state()]).toEqual(["unread", "missing", "present"]);
  });

  it("is refused once the file turns readable by others", () => {
    const file = secretFile();
    writeFileSync(file, SECRET, { mode: 0o600 });
    const secret = trackWebhookSecret(file);
    secret.read();

    chmodSync(file, 0o644);

    expect(() => secret.read()).toThrow(/refused/);
    expect(secret.state()).toBe("refused");
  });
});
