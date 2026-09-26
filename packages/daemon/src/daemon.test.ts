import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DaemonAlreadyRunningError, startDaemon, type DaemonHandle, type StartDaemonOptions } from "./daemon.js";
import { daemonPaths, readPidFile } from "./lifecycle.js";
import { silentLogger } from "./logger.js";
import { createTestContext, createTestRegistry, type TestContext } from "./test-fixtures.js";

let stateDir: string;
let handle: DaemonHandle | null = null;

function options(overrides: Partial<StartDaemonOptions<TestContext>> = {}): StartDaemonOptions<TestContext> {
  return {
    registry: createTestRegistry(),
    createContext: createTestContext,
    version: "1.2.3",
    stateDir,
    port: 0,
    logger: silentLogger,
    ...overrides,
  };
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "titan-daemon-"));
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  await rm(stateDir, { recursive: true, force: true });
});

describe("startDaemon", () => {
  it("serves health and rpc over a real socket on an ephemeral port", async () => {
    handle = await startDaemon(options({ health: () => ({ mode: "test" }) }));
    expect(handle.port).toBeGreaterThan(0);

    const health = await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json();
    expect(health).toMatchObject({ ok: true, version: "1.2.3", port: handle.port, mode: "test" });

    const rpc = await fetch(`http://127.0.0.1:${handle.port}/rpc/greet`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-titan-client": "test" },
      body: JSON.stringify({ name: "socket" }),
    });
    expect(await rpc.json()).toMatchObject({ ok: true, data: { greeting: "hello socket" } });
  });

  it("owns a pid file for its lifetime and releases it on close", async () => {
    handle = await startDaemon(options());
    const paths = daemonPaths(stateDir);

    expect(await readPidFile(paths)).toMatchObject({ pid: process.pid, meta: { port: handle.port, version: "1.2.3" } });

    const port = handle.port;
    await handle.close();
    handle = null;

    expect(await readPidFile(paths)).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("refuses to start twice against the same state directory", async () => {
    handle = await startDaemon(options());

    await expect(startDaemon(options())).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it("serves mcp alongside the hono routes when a tool prefix is set", async () => {
    handle = await startDaemon(options({ toolPrefix: "test__" }));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), { requestInit: { headers: { "x-titan-client": "test" } } }));

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["test__boom", "test__greet"]);
    await client.close();
  });

  it("broadcasts a change event when the watched tree changes", { timeout: 15_000 }, async () => {
    handle = await startDaemon(options({ watchRoot: stateDir }));
    const events: string[] = [];
    handle.hub.subscribe((message) => {
      events.push(message.event);
    });

    // Retried: macOS drops the first fs.watch event a few percent of the time.
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; events.length === 0 && Date.now() < deadline; attempt++) {
      await writeFile(path.join(stateDir, `touched-${attempt}.md`), "hello");
      const window = Date.now() + 400;
      while (events.length === 0 && Date.now() < window) await new Promise((r) => setTimeout(r, 5));
    }

    expect(events).toEqual(["change"]);
  });

  it("closes cleanly more than once", async () => {
    handle = await startDaemon(options());

    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
    handle = null;
  });

  it("closes while a client still holds a connection open", async () => {
    handle = await startDaemon(options({ shutdownGraceMs: 50 }));
    const socket = connect(handle.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write("GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
    await once(socket, "data");

    await expect(withTimeout(handle.close(), 5_000)).resolves.toBeUndefined();

    socket.destroy();
    handle = null;
  });
});

describe("request guards over a real socket", () => {
  it("refuses the cross-origin probe: text/plain body with a foreign Host and Origin", async () => {
    handle = await startDaemon(options());

    const headers = { "content-type": "text/plain", host: "evil.example", origin: "http://evil.example" };
    const res = await post(handle.port, "/rpc/greet", headers, '{"name":"probe"}');

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 64 });
  });

  it("refuses a rebinding Host that carries a well-formed JSON body", async () => {
    handle = await startDaemon(options());

    const res = await post(handle.port, "/rpc/greet", { "content-type": "application/json", host: "evil.example" }, '{"name":"probe"}');

    expect(res.status).toBe(403);
  });

  it("serves a loopback JSON POST with no Origin when it carries the client header", async () => {
    handle = await startDaemon(options());

    const headers = { "content-type": "application/json", "x-titan-client": "test" };
    const res = await post(handle.port, "/rpc/greet", headers, '{"name":"socket"}');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, data: { greeting: "hello socket" } });
  });

  it("refuses a loopback JSON POST with neither Origin nor the client header", async () => {
    handle = await startDaemon(options());

    const res = await post(handle.port, "/rpc/greet", { "content-type": "application/json" }, '{"name":"socket"}');

    expect(res.status).toBe(403);
  });

  it("guards the mcp transport the same way", async () => {
    handle = await startDaemon(options({ toolPrefix: "test__" }));
    const listTools = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';

    const rebound = await post(handle.port, "/mcp", { "content-type": "application/json", host: "evil.example" }, listTools);
    const accept = "application/json, text/event-stream";
    const anonymous = await post(handle.port, "/mcp", { "content-type": "application/json", accept }, listTools);
    const plain = await post(handle.port, "/mcp", { "content-type": "text/plain", accept, "x-titan-client": "test" }, listTools);
    const named = await post(handle.port, "/mcp", { "content-type": "application/json", accept, "x-titan-client": "test" }, listTools);

    expect(rebound.status).toBe(403);
    expect(anonymous.status).toBe(403);
    expect(named.status).toBe(200);
    expect(plain.status).toBe(415);
    expect(JSON.parse(plain.body)).toMatchObject({ ok: false, error: "Content-Type must be application/json" });
  });
});

function post(port: number, route: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: route, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const expiry = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`close did not settle within ${ms}ms`)), ms).unref();
  });
  return Promise.race([promise, expiry]);
}
