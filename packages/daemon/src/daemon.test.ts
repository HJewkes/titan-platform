import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SESSION_COOKIE, TokenFileError, ensureTokenFile, signSession } from "./auth.js";
import { DaemonAlreadyRunningError, DaemonPortInUseError, startDaemon, type DaemonHandle, type StartDaemonOptions } from "./daemon.js";
import type * as BindGuardModule from "./bind-guard.js";
import { NonLoopbackBindError, RemoteBindError, assertRemoteHost } from "./bind-guard.js";
import { daemonPaths, readPidFile, writePidFile } from "./lifecycle.js";
import { silentLogger } from "./logger.js";
import { createTestContext, createTestRegistry, type TestContext } from "./test-fixtures.js";

// The one test seam for the remote listener: 127.0.0.2 is loopback, so the remote suite lets
// exactly that address past the refusal. Every other host still meets the real check.
vi.mock("./bind-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BindGuardModule>();
  return { ...actual, assertRemoteHost: vi.fn(actual.assertRemoteHost) };
});

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

describe("startDaemon bind guard", () => {
  it.each(["0.0.0.0", "::", "192.168.1.20", "example.test", ""])("refuses %j before binding or writing the pid file", async (host) => {
    const attempt = startDaemon(options({ host }));
    await expect(attempt).rejects.toBeInstanceOf(NonLoopbackBindError);
    await expect(attempt).rejects.toMatchObject({ host });
    expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
  });

  it.each(["127.0.0.1", "localhost", "LOCALHOST"])("starts on loopback spelling %s", async (host) => {
    handle = await startDaemon(options({ host }));
    expect(handle.port).toBeGreaterThan(0);
  });

  it("starts on 0.0.0.0 when the unauthenticated opt-in is set", async () => {
    handle = await startDaemon(options({ host: "0.0.0.0", allowUnauthenticatedNonLoopback: true }));
    expect((await fetch(`http://127.0.0.1:${handle.port}/health`)).status).toBe(200);
  });

  it("treats a truthy but non-true opt-in as not set", async () => {
    const truthy = "false" as unknown as boolean;
    await expect(startDaemon(options({ host: "0.0.0.0", allowUnauthenticatedNonLoopback: truthy }))).rejects.toBeInstanceOf(NonLoopbackBindError);
  });

  const lanAddress = Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;
  it.skipIf(!lanAddress)("binds loopback only when no host is given", async () => {
    handle = await startDaemon(options());
    await expect(fetch(`http://${lanAddress}:${handle.port}/health`)).rejects.toThrow();
  });

  it("does not read the opt-in from the environment", async () => {
    process.env.ALLOW_UNAUTHENTICATED_NON_LOOPBACK = "true";
    try {
      await expect(startDaemon(options({ host: "0.0.0.0" }))).rejects.toBeInstanceOf(NonLoopbackBindError);
    } finally {
      delete process.env.ALLOW_UNAUTHENTICATED_NON_LOOPBACK;
    }
  });
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

describe("stale pid file", () => {
  const minuteAgo = (): Date => new Date(Date.now() - 60_000);
  const minuteAhead = (): Date => new Date(Date.now() + 60_000);

  async function seedPidFile(pid: number, port: number): Promise<void> {
    await writePidFile(daemonPaths(stateDir), pid, { port, version: "0.0.1", started: "" });
  }

  it("starts when a live pid began after the pid file was written (pid reused after reboot)", async () => {
    await seedPidFile(process.pid, 1);

    handle = await startDaemon(options({ processStartTime: minuteAhead }));

    expect((await readPidFile(daemonPaths(stateDir)))?.pid).toBe(process.pid);
  });

  it("starts when the recorded pid is dead", async () => {
    await seedPidFile(2 ** 22 + 12345, 1);

    handle = await startDaemon(options({ processStartTime: minuteAgo }));

    expect(handle.port).toBeGreaterThan(0);
  });

  it("refuses when the pid is newer than the file but the recorded port answers health", async () => {
    const live = await startDaemon(options());
    handle = live;

    await expect(startDaemon(options({ processStartTime: minuteAhead }))).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  describe("when the process start time is unknown", () => {
    const unknown = (): null => null;

    async function withHealthStatus(status: number | null, run: (port: number) => Promise<void>): Promise<void> {
      if (status === null) return run(1);
      const server = createServer((_req, res) => res.writeHead(status).end("{}"));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        await run((server.address() as AddressInfo).port);
      } finally {
        server.close();
      }
    }

    it.each([null, 503])("refuses and keeps the pid file when health gives %s", async (status) => {
      await withHealthStatus(status, async (port) => {
        await seedPidFile(process.pid, port);

        await expect(startDaemon(options({ processStartTime: unknown }))).rejects.toMatchObject({ name: "DaemonAlreadyRunningError", pid: process.pid });

        expect((await readPidFile(daemonPaths(stateDir)))?.pid).toBe(process.pid);
      });
    });

    it("refuses when the meta file is missing too", async () => {
      await writeFile(daemonPaths(stateDir).pidFile, String(process.pid));

      await expect(startDaemon(options({ processStartTime: unknown }))).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    });
  });
});

describe("startDaemon port conflicts", () => {
  it("rejects the second daemon on a taken port while the first keeps serving", async () => {
    handle = await startDaemon(options({ port: 0 }));
    const { port } = handle;
    const otherStateDir = await mkdtemp(path.join(tmpdir(), "titan-daemon-other-"));
    try {
      const failure = await startDaemon(options({ port, stateDir: otherStateDir })).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(DaemonPortInUseError);
      expect((failure as DaemonPortInUseError).port).toBe(port);
      expect((failure as Error).message).toContain(String(port));
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await rm(otherStateDir, { recursive: true, force: true });
    }
  });
});

const REMOTE = "127.0.0.2";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(address: string, port: number, method: string, route: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port, path: route, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** The first bytes of a response; for a stream that never ends, such as `/events`. */
function sendHead(address: string, port: number, route: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port, path: route, headers }, (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", reject);
    req.end();
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function refusesConnection(address: string, port: number): Promise<boolean> {
  return send(address, port, "GET", "/health").then(
    () => false,
    () => true,
  );
}

describe("startDaemon remote host refusal", () => {
  let tokenFile: string;
  beforeEach(() => {
    tokenFile = path.join(stateDir, "lan.token");
    ensureTokenFile(tokenFile);
  });

  it.each(["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "127.0.0.1", REMOTE, "::1", "::ffff:127.0.0.1", "localhost", "lan-box", "", "[192.168.1.20]"])(
    "refuses remote.host %j before binding or writing the pid file",
    async (host) => {
      const attempt = startDaemon(options({ remote: { host, tokenFile } }));

      await expect(attempt).rejects.toBeInstanceOf(RemoteBindError);
      await expect(attempt).rejects.toMatchObject({ host });
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    },
  );

  it("refuses a remote listener beside an unauthenticated non-loopback one", async () => {
    const attempt = startDaemon(options({ host: "0.0.0.0", allowUnauthenticatedNonLoopback: true, remote: { host: "192.0.2.1", tokenFile } }));

    await expect(attempt).rejects.toBeInstanceOf(RemoteBindError);
  });

  it("refuses a missing token file before binding", async () => {
    const port = await freePort();
    const attempt = startDaemon(options({ port, remote: { host: "192.0.2.1", tokenFile: path.join(stateDir, "absent.token") } }));

    await expect(attempt).rejects.toMatchObject({ code: "ENOENT" });
    expect(await refusesConnection("127.0.0.1", port)).toBe(true);
  });

  it("refuses a group-readable token file before binding", async () => {
    const port = await freePort();
    await chmod(tokenFile, 0o640);
    const attempt = startDaemon(options({ port, remote: { host: "192.0.2.1", tokenFile } }));

    await expect(attempt).rejects.toBeInstanceOf(TokenFileError);
    expect(await refusesConnection("127.0.0.1", port)).toBe(true);
  });

  it("binds both listeners or neither: a remote bind failure closes loopback and writes no pid file", async () => {
    const port = await freePort();

    const failure = await startDaemon(options({ port, remote: { host: "192.0.2.1", tokenFile } })).catch((err: unknown) => err);

    expect(failure).toMatchObject({ code: "EADDRNOTAVAIL" });
    expect(await refusesConnection("127.0.0.1", port)).toBe(true);
    expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    handle = await startDaemon(options({ port }));
    expect(handle.port).toBe(port);
  });
});

// Linux routes all of 127/8 to lo; macOS answers only 127.0.0.1 unless an alias is added.
describe.skipIf(process.platform !== "linux")("startDaemon remote listener (127.0.0.2 stands in for the LAN)", () => {
  let tokenFile: string;
  let secret: string;
  const json = { "content-type": "application/json" };

  beforeEach(() => {
    vi.mocked(assertRemoteHost).mockImplementation((host) => {
      if (host !== REMOTE) throw new RemoteBindError(host, "is not the test stand-in");
    });
    tokenFile = path.join(stateDir, "lan.token");
    secret = ensureTokenFile(tokenFile);
  });

  afterEach(() => {
    vi.mocked(assertRemoteHost).mockReset();
  });

  async function startRemote(overrides: Partial<StartDaemonOptions<TestContext>> = {}): Promise<number> {
    handle = await startDaemon(options({ remote: { host: REMOTE, tokenFile, allowedHosts: ["lan-box"] }, ...overrides }));
    return handle.port;
  }

  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${secret}` });
  const cookie = (): Record<string, string> => ({ cookie: `${SESSION_COOKIE}=${signSession(secret)}` });
  const remoteOrigin = (port: number): Record<string, string> => ({ origin: `http://${REMOTE}:${port}` });

  it("answers 401 on /health and /rpc without credentials", async () => {
    const port = await startRemote();

    const health = await send(REMOTE, port, "GET", "/health");
    const rpc = await send(REMOTE, port, "POST", "/rpc/greet", { ...json, ...remoteOrigin(port) }, '{"name":"lan"}');

    expect(health.status).toBe(401);
    expect(rpc.status).toBe(401);
  });

  it("answers 401 on /events without credentials", async () => {
    const port = await startRemote();

    expect(await sendHead(REMOTE, port, "/events", {})).toBe(401);
  });

  it.each([
    ["bearer", bearer],
    ["session cookie", cookie],
  ])("serves /health and /rpc with a %s", async (_kind, credential) => {
    const port = await startRemote();

    const health = await send(REMOTE, port, "GET", "/health", credential());
    const rpc = await send(REMOTE, port, "POST", "/rpc/greet", { ...json, ...remoteOrigin(port), ...credential() }, '{"name":"lan"}');

    expect(health.status).toBe(200);
    expect(rpc.status).toBe(200);
    expect(JSON.parse(rpc.body)).toMatchObject({ ok: true, data: { greeting: "hello lan" } });
  });

  it("answers the configured LAN name with the bound port", async () => {
    const port = await startRemote();

    expect((await send(REMOTE, port, "GET", "/health", { host: `lan-box:${port}`, ...bearer() })).status).toBe(200);
  });

  it("refuses a cross-site Origin on a cookie POST", async () => {
    const port = await startRemote();

    const res = await send(REMOTE, port, "POST", "/rpc/greet", { ...json, ...cookie(), origin: "http://evil.example" }, "{}");

    expect(res.status).toBe(403);
  });

  it.each([`http://${REMOTE}`, "http://lan-box", `https://${REMOTE}`])("refuses the portless Origin %s on a cookie POST", async (origin) => {
    const port = await startRemote();

    const res = await send(REMOTE, port, "POST", "/rpc/greet", { ...json, ...cookie(), origin }, "{}");

    expect(res.status).toBe(403);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("refuses the loopback Host %s even with a credential", async (name) => {
    const port = await startRemote();

    expect((await send(REMOTE, port, "GET", "/health", { host: `${name}:${port}`, ...bearer() })).status).toBe(403);
  });

  it("refuses a portless Host", async () => {
    const port = await startRemote();

    expect((await send(REMOTE, port, "GET", "/health", { host: REMOTE, ...bearer() })).status).toBe(403);
  });

  it("runs the Host guard before the auth gate, /auth/login included", async () => {
    const port = await startRemote();
    const foreign = { host: `evil.example:${port}` };

    const page = await send(REMOTE, port, "GET", "/auth/login?code=x", foreign);
    const login = await send(REMOTE, port, "POST", "/auth/login", { ...foreign, ...json, origin: `http://evil.example:${port}` }, '{"code":"x"}');
    const health = await send(REMOTE, port, "GET", "/health", foreign);

    expect([page.status, login.status, health.status]).toEqual([403, 403, 403]);
  });

  it("never serves /mcp remotely, while loopback still does", async () => {
    const port = await startRemote({ toolPrefix: "test__" });
    const listTools = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const mcpHeaders = { ...json, accept: "application/json, text/event-stream", "x-titan-client": "test" };

    const anonymous = await send(REMOTE, port, "POST", "/mcp", mcpHeaders, listTools);
    const authed = await send(REMOTE, port, "POST", "/mcp", { ...mcpHeaders, ...bearer() }, listTools);
    const local = await send("127.0.0.1", port, "POST", "/mcp", mcpHeaders, listTools);

    expect([anonymous.status, authed.status, local.status]).toEqual([401, 404, 200]);
  });

  it("serves loopback without credentials and keeps LAN names off its allowlist", async () => {
    const port = await startRemote();

    const health = await send("127.0.0.1", port, "GET", "/health");
    const rpc = await send("127.0.0.1", port, "POST", "/rpc/greet", { ...json, "x-titan-client": "test" }, '{"name":"local"}');
    const lanName = await send("127.0.0.1", port, "GET", "/health", { host: `lan-box:${port}` });

    expect([health.status, rpc.status, lanName.status]).toEqual([200, 200, 403]);
  });

  it("tells createContext the peer is this machine", async () => {
    const createContext = vi.fn(createTestContext);
    const port = await startRemote({ createContext });

    await send(REMOTE, port, "POST", "/rpc/greet", { ...json, "x-titan-client": "test", ...bearer() }, "{}");

    expect(createContext).toHaveBeenCalledWith("http", { credential: "bearer", issuedAt: null, peerLocal: true });
  });

  it("closes both listeners and releases the pid file", async () => {
    const port = await startRemote();

    await handle!.close();
    handle = null;

    expect(await refusesConnection("127.0.0.1", port)).toBe(true);
    expect(await refusesConnection(REMOTE, port)).toBe(true);
    expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
  });

  it("binds neither when the remote port is taken, and names the remote host", async () => {
    const port = await freePort();
    const squatter = createServer();
    squatter.listen(port, REMOTE);
    await once(squatter, "listening");
    try {
      const failure = await startDaemon(options({ port, remote: { host: REMOTE, tokenFile } })).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DaemonPortInUseError);
      expect(failure).toMatchObject({ port, host: REMOTE });
      expect(await refusesConnection("127.0.0.1", port)).toBe(true);
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    } finally {
      squatter.close();
    }
  });

  it("answers loopback byte for byte as a daemon without a remote listener does", async () => {
    const probes = async (port: number): Promise<string[]> => {
      const replies = [
        await send("127.0.0.1", port, "GET", "/version"),
        await send("127.0.0.1", port, "POST", "/rpc/greet", { ...json, "x-titan-client": "t" }, '{"name":"same"}'),
        await send("127.0.0.1", port, "POST", "/rpc/greet", { ...json, origin: "http://127.0.0.1" }, '{"name":"same"}'),
        await send("127.0.0.1", port, "POST", "/rpc/greet", { ...json, origin: "http://evil.example" }, "{}"),
        await send("127.0.0.1", port, "GET", "/health", { host: "evil.example" }),
        await send("127.0.0.1", port, "GET", "/auth/login"),
        // Uptime changes the length, so /health compares its status and field names only.
        await send("127.0.0.1", port, "GET", "/health", { host: "localhost" }).then((r) => ({ status: r.status, headers: {}, body: Object.keys(JSON.parse(r.body)).sort().join() })),
      ];
      return replies.map(({ status, headers, body }) => JSON.stringify({ status, body, headers: { ...headers, date: undefined } }));
    };
    const port = await freePort();

    handle = await startDaemon(options({ port }));
    const plain = await probes(port);
    await handle.close();
    handle = await startDaemon(options({ port, remote: { host: REMOTE, tokenFile } }));
    const withRemote = await probes(port);

    expect(withRemote).toEqual(plain);
  });
});
