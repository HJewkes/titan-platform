import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, request, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { connect as tlsConnect } from "node:tls";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SESSION_COOKIE, TokenFileError, ensureTokenFile, mintLoginCode, signSession } from "./auth.js";
import { DaemonAlreadyRunningError, DaemonPortInUseError, startDaemon, type DaemonHandle, type RemoteListenerOptions, type StartDaemonOptions } from "./daemon.js";
import type * as BindGuardModule from "./bind-guard.js";
import { NonLoopbackBindError, RemoteBindError, assertRemoteHost } from "./bind-guard.js";
import { daemonPaths, readPidFile, writePidFile } from "./lifecycle.js";
import { silentLogger } from "./logger.js";
import { createTestContext, createTestRegistry, writeSelfSignedCert, type SelfSignedPair, type TestContext } from "./test-fixtures.js";
import { TlsFileError } from "./tls-files.js";

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

/** How to reach a TLS listener: the self-signed certificate to trust, and the name to verify it against. */
interface Tls {
  ca: string;
  servername?: string;
}

function open(options: RequestOptions, tls: Tls | undefined, onResponse: (res: IncomingMessage) => void): ClientRequest {
  return tls ? httpsRequest({ ...options, ...tls }, onResponse) : request(options, onResponse);
}

function send(address: string, port: number, method: string, route: string, headers: Record<string, string> = {}, body?: string, tls?: Tls): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = open({ host: address, port, path: route, method, headers }, tls, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** The first bytes of a response; for a stream that never ends, such as `/events`. */
function sendHead(address: string, port: number, route: string, headers: Record<string, string>, tls?: Tls): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = open({ host: address, port, path: route, headers }, tls, (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", reject);
    req.end();
  });
}

/** The SHA-256 fingerprint of the certificate the listener presents to a new connection. */
function servedFingerprint(address: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: address, port, rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate().fingerprint256);
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

async function holdPort(address: string, port = 0): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer();
  server.listen(port, address);
  await once(server, "listening");
  return { port: (server.address() as AddressInfo).port, release: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function bindOnce(address: string, port: number): Promise<boolean> {
  return holdPort(address, port).then(
    ({ release }) => release().then(() => true),
    () => false,
  );
}

/**
 * Released means this process can bind the address and port again. close() has already resolved
 * on the server's own close event, so a refusal right after it is another test file's worker
 * taking the freed ephemeral port for a moment; that clears, a listener that leaked does not,
 * so the wait is bounded and a leak still fails.
 */
async function canBind(address: string, port: number, waitMs = 2000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (!(await bindOnce(address, port))) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

const LOOPBACK_RACE_ATTEMPTS = 5;

/**
 * Run a start that is expected to fail on a port probed free, then released. Parallel test files
 * bind ephemeral ports too and can take it in that gap; only that loss, the daemon's own
 * loopback bind refused, earns a fresh port.
 */
async function failOnProbedPort(start: (port: number) => Promise<DaemonHandle>): Promise<{ port: number; failure: unknown }> {
  for (let attempt = 1; ; attempt++) {
    const probe = await holdPort("127.0.0.1");
    await probe.release();
    const failure = await start(probe.port).then(
      async (started) => {
        await started.close();
        return new Error("started when it should have failed");
      },
      (err: unknown) => err,
    );
    const lostRace = failure instanceof DaemonPortInUseError && failure.host === "127.0.0.1";
    if (!lostRace || attempt === LOOPBACK_RACE_ATTEMPTS) return { port: probe.port, failure };
  }
}

describe("startDaemon remote host refusal", () => {
  let tokenFile: string;
  let tls: SelfSignedPair;
  beforeEach(() => {
    tokenFile = path.join(stateDir, "lan.token");
    ensureTokenFile(tokenFile);
    tls = writeSelfSignedCert(stateDir, ["lan-box"]);
  });

  it.each(["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "127.0.0.1", REMOTE, "::1", "::ffff:127.0.0.1", "localhost", "lan-box", "", "[192.168.1.20]"])(
    "refuses remote.host %j before binding or writing the pid file",
    async (host) => {
      const attempt = startDaemon(options({ remote: { host, tokenFile, tls } }));

      await expect(attempt).rejects.toBeInstanceOf(RemoteBindError);
      await expect(attempt).rejects.toMatchObject({ host });
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    },
  );

  it("refuses a remote listener beside an unauthenticated non-loopback one", async () => {
    const attempt = startDaemon(options({ host: "0.0.0.0", allowUnauthenticatedNonLoopback: true, remote: { host: "192.0.2.1", tokenFile, tls } }));

    await expect(attempt).rejects.toBeInstanceOf(RemoteBindError);
  });

  // The loopback port stays held: a start that bound before reading the file would fail with
  // DaemonPortInUseError instead, so the token error proves the file is read first.
  it("refuses a missing token file before binding", async () => {
    const held = await holdPort("127.0.0.1");
    try {
      const attempt = startDaemon(options({ port: held.port, remote: { host: "192.0.2.1", tokenFile: path.join(stateDir, "absent.token"), tls } }));

      await expect(attempt).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await held.release();
    }
  });

  it("refuses a group-readable token file before binding", async () => {
    const held = await holdPort("127.0.0.1");
    await chmod(tokenFile, 0o640);
    try {
      const attempt = startDaemon(options({ port: held.port, remote: { host: "192.0.2.1", tokenFile, tls } }));

      await expect(attempt).rejects.toBeInstanceOf(TokenFileError);
    } finally {
      await held.release();
    }
  });

  it.each([
    ["no tls at all", undefined],
    ["an empty certFile", { certFile: "", keyFile: "k" }],
    ["an empty keyFile", { certFile: "c", keyFile: "" }],
  ])("refuses a remote listener with %s, which would serve plain HTTP, before binding", async (_label, noTls) => {
    const held = await holdPort("127.0.0.1");
    try {
      const remote = { host: "192.0.2.1", tokenFile, tls: noTls } as unknown as RemoteListenerOptions;
      const attempt = startDaemon(options({ port: held.port, remote }));

      await expect(attempt).rejects.toThrow(/it has no TLS/);
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    } finally {
      await held.release();
    }
  });

  it.each([
    ["a missing certificate", () => ({ ...tls, certFile: path.join(stateDir, "absent.crt") }), /absent\.crt refused: it cannot be opened \(ENOENT\)/],
    ["a missing key", () => ({ ...tls, keyFile: path.join(stateDir, "absent.key") }), /absent\.key refused: it cannot be opened \(ENOENT\)/],
    ["a key that is not the certificate's", () => ({ ...tls, keyFile: writeSelfSignedCert(stateDir, ["lan-box"], { prefix: "other" }).keyFile }), /not the key of the certificate/],
    ["a certificate that does not cover an allowed name", () => writeSelfSignedCert(stateDir, ["elsewhere"], { prefix: "elsewhere" }), /does not cover the name "lan-box"/],
    ["a certificate that is not PEM", () => ({ ...tls, certFile: tokenFile }), /not valid PEM/],
  ])("fails start on %s, binding nothing and writing no pid file", async (_label, files, message) => {
    const held = await holdPort("127.0.0.1");
    try {
      const attempt = startDaemon(options({ port: held.port, remote: { host: "192.0.2.1", tokenFile, tls: files(), allowedHosts: ["lan-box"] } }));

      await expect(attempt).rejects.toBeInstanceOf(TlsFileError);
      await expect(attempt).rejects.toThrow(message);
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    } finally {
      await held.release();
    }
  });

  it("fails start on an expired certificate", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    try {
      const attempt = startDaemon(options({ remote: { host: "192.0.2.1", tokenFile, tls } }));

      await expect(attempt).rejects.toThrow(/it is valid only from/);
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails start on a group-readable key", async () => {
    await chmod(tls.keyFile, 0o640);

    const attempt = startDaemon(options({ remote: { host: "192.0.2.1", tokenFile, tls } }));

    await expect(attempt).rejects.toThrow(/readable by group or others/);
    expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
  });

  it("binds both listeners or neither: a remote bind failure closes loopback and writes no pid file", async () => {
    const { port, failure } = await failOnProbedPort((probed) => startDaemon(options({ port: probed, remote: { host: "192.0.2.1", tokenFile, tls } })));

    expect(failure).toMatchObject({ code: "EADDRNOTAVAIL" });
    expect(await canBind("127.0.0.1", port)).toBe(true);
    expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
  });
});

// Linux routes all of 127/8 to lo; macOS answers only 127.0.0.1 unless an alias is added.
describe.skipIf(process.platform !== "linux")("startDaemon remote listener (127.0.0.2 stands in for the LAN)", () => {
  const FQDN = "lan-box.example.ts.net";
  let tokenFile: string;
  let secret: string;
  let pair: SelfSignedPair;
  let port: number;
  const json = { "content-type": "application/json" };

  beforeEach(() => {
    vi.mocked(assertRemoteHost).mockImplementation((host) => {
      if (host !== REMOTE) throw new RemoteBindError(host, "is not the test stand-in");
    });
    tokenFile = path.join(stateDir, "lan.token");
    secret = ensureTokenFile(tokenFile);
    pair = writeSelfSignedCert(stateDir, [FQDN, "lan-box", REMOTE]);
  });

  afterEach(() => {
    vi.mocked(assertRemoteHost).mockReset();
  });

  const remoteOptions = (extra: Partial<RemoteListenerOptions> = {}): RemoteListenerOptions => ({
    host: REMOTE,
    tokenFile,
    tls: { certFile: pair.certFile, keyFile: pair.keyFile },
    allowedHosts: ["lan-box", FQDN],
    ...extra,
  });

  async function startRemote(overrides: Partial<StartDaemonOptions<TestContext>> = {}): Promise<number> {
    handle = await startDaemon(options({ remote: remoteOptions(), ...overrides }));
    port = handle.port;
    return port;
  }

  /** An HTTPS request to the remote listener that trusts the test certificate. */
  const sendRemote = (method: string, route: string, headers: Record<string, string> = {}, body?: string, servername = FQDN): Promise<Reply> =>
    send(REMOTE, port, method, route, headers, body, { ca: pair.cert, servername });
  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${secret}` });
  const cookie = (): Record<string, string> => ({ cookie: `${SESSION_COOKIE}=${signSession(secret)}` });
  const remoteOrigin = (): Record<string, string> => ({ origin: `https://${REMOTE}:${port}` });

  it("answers 401 on /health and /rpc without credentials", async () => {
    await startRemote();

    const health = await sendRemote("GET", "/health");
    const rpc = await sendRemote("POST", "/rpc/greet", { ...json, ...remoteOrigin() }, '{"name":"lan"}');

    expect(health.status).toBe(401);
    expect(rpc.status).toBe(401);
  });

  it("answers 401 on /events without credentials", async () => {
    await startRemote();

    expect(await sendHead(REMOTE, port, "/events", {}, { ca: pair.cert, servername: FQDN })).toBe(401);
  });

  it.each([
    ["bearer", bearer],
    ["session cookie", cookie],
  ])("serves /health and /rpc over HTTPS with a %s", async (_kind, credential) => {
    await startRemote();

    const health = await sendRemote("GET", "/health", credential());
    const rpc = await sendRemote("POST", "/rpc/greet", { ...json, ...remoteOrigin(), ...credential() }, '{"name":"lan"}');

    expect(health.status).toBe(200);
    expect(rpc.status).toBe(200);
    expect(JSON.parse(rpc.body)).toMatchObject({ ok: true, data: { greeting: "hello lan" } });
  });

  it("refuses plain HTTP on the remote listener with no HTTP reply, while loopback still answers it", async () => {
    await startRemote();

    await expect(send(REMOTE, port, "GET", "/health", { host: `${FQDN}:${port}`, ...bearer() })).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect((await send("127.0.0.1", port, "GET", "/health")).status).toBe(200);
  });

  it("sets the session cookie Secure, HttpOnly and SameSite=Strict, and clears it the same way", async () => {
    await startRemote();
    const sameSite = { host: `${FQDN}:${port}`, origin: `https://${FQDN}:${port}` };

    const login = await sendRemote("POST", "/auth/login", { ...json, ...sameSite }, JSON.stringify({ code: mintLoginCode(secret) }), FQDN);
    const set = [login.headers["set-cookie"] ?? []].flat().join("\n");
    const logout = await sendRemote("POST", "/auth/logout", { ...json, ...sameSite, ...cookie() }, "{}", FQDN);
    const cleared = [logout.headers["set-cookie"] ?? []].flat().join("\n");

    expect(login.status).toBe(200);
    expect(set).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
    expect(set).toMatch(/; Secure/);
    expect(set).toMatch(/; HttpOnly/);
    expect(set).toMatch(/; SameSite=Strict/);
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/; Secure/);
  });

  it("answers the tailnet name with its port, verifying the certificate against that name", async () => {
    await startRemote();

    const health = await sendRemote("GET", "/health", { host: `${FQDN}:${port}`, ...bearer() }, undefined, FQDN);
    const rpc = await sendRemote("POST", "/rpc/greet", { ...json, host: `${FQDN}:${port}`, origin: `https://${FQDN}:${port}`, ...cookie() }, '{"name":"tailnet"}', FQDN);

    expect([health.status, rpc.status]).toEqual([200, 200]);
  });

  it("refuses the tailnet name without its port, or with another port", async () => {
    await startRemote();

    const portless = await sendRemote("GET", "/health", { host: FQDN, ...bearer() }, undefined, FQDN);
    const otherPort = await sendRemote("GET", "/health", { host: `${FQDN}:${port + 1}`, ...bearer() }, undefined, FQDN);

    expect([portless.status, otherPort.status]).toEqual([403, 403]);
  });

  it("refuses an http:// Origin for its own name and port: on a TLS listener that is another site", async () => {
    await startRemote();

    const statuses = await Promise.all(
      [`http://${FQDN}:${port}`, `http://${REMOTE}:${port}`, `https://${FQDN}`, `https://${FQDN}:${port + 1}`].map(
        async (origin) => (await sendRemote("POST", "/rpc/greet", { ...json, host: `${FQDN}:${port}`, origin, ...cookie() }, "{}", FQDN)).status,
      ),
    );

    expect(statuses).toEqual([403, 403, 403, 403]);
  });

  it("refuses a cross-site Origin on a cookie POST", async () => {
    await startRemote();

    const res = await sendRemote("POST", "/rpc/greet", { ...json, ...cookie(), origin: "https://evil.example" }, "{}");

    expect(res.status).toBe(403);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("refuses the loopback Host %s even with a credential", async (name) => {
    await startRemote();

    expect((await sendRemote("GET", "/health", { host: `${name}:${port}`, ...bearer() })).status).toBe(403);
  });

  it("runs the Host guard before the auth gate, /auth/login included", async () => {
    await startRemote();
    const foreign = { host: `evil.example:${port}` };

    const page = await sendRemote("GET", "/auth/login?code=x", foreign);
    const login = await sendRemote("POST", "/auth/login", { ...foreign, ...json, origin: `https://evil.example:${port}` }, '{"code":"x"}');
    const health = await sendRemote("GET", "/health", foreign);

    expect([page.status, login.status, health.status]).toEqual([403, 403, 403]);
  });

  it("never serves /mcp remotely, while loopback still does", async () => {
    await startRemote({ toolPrefix: "test__" });
    const listTools = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const mcpHeaders = { ...json, accept: "application/json, text/event-stream", "x-titan-client": "test" };

    const anonymous = await sendRemote("POST", "/mcp", mcpHeaders, listTools);
    const authed = await sendRemote("POST", "/mcp", { ...mcpHeaders, ...bearer() }, listTools);
    const local = await send("127.0.0.1", port, "POST", "/mcp", mcpHeaders, listTools);

    expect([anonymous.status, authed.status, local.status]).toEqual([401, 404, 200]);
  });

  it("serves loopback without credentials and keeps LAN names off its allowlist", async () => {
    await startRemote();

    const health = await send("127.0.0.1", port, "GET", "/health");
    const rpc = await send("127.0.0.1", port, "POST", "/rpc/greet", { ...json, "x-titan-client": "test" }, '{"name":"local"}');
    const lanName = await send("127.0.0.1", port, "GET", "/health", { host: `${FQDN}:${port}` });

    expect([health.status, rpc.status, lanName.status]).toEqual([200, 200, 403]);
  });

  it("tells createContext the peer is this machine over TLS, as it did over plain HTTP", async () => {
    const createContext = vi.fn(createTestContext);
    await startRemote({ createContext });

    await sendRemote("POST", "/rpc/greet", { ...json, "x-titan-client": "test", ...bearer() }, "{}");

    expect(createContext).toHaveBeenCalledWith("http", { credential: "bearer", issuedAt: null, peerLocal: true });
  });

  it("serves a renewed pair to new connections without a restart", async () => {
    handle = await startDaemon(options({ remote: remoteOptions({ tlsReloadMs: 20 }) }));
    port = handle.port;
    const before = await servedFingerprint(REMOTE, port);

    const renewed = writeSelfSignedCert(stateDir, [FQDN, "lan-box", REMOTE], { prefix: "renewed" });
    await rename(renewed.keyFile, pair.keyFile);
    await rename(renewed.certFile, pair.certFile);
    const after = await waitFor(() => servedFingerprint(REMOTE, port), (fingerprint) => fingerprint !== before);

    expect(after).not.toBe(before);
    expect((await send(REMOTE, port, "GET", "/health", bearer(), undefined, { ca: renewed.cert })).status).toBe(200);
  });

  it("keeps serving the last good pair, never plain HTTP, when a renewal leaves the files unusable", async () => {
    const errors: string[] = [];
    const logger = { ...silentLogger, error: (_fields: Record<string, unknown>, message: string) => void errors.push(message) };
    handle = await startDaemon(options({ remote: remoteOptions({ tlsReloadMs: 20 }), logger }));
    port = handle.port;
    const before = await servedFingerprint(REMOTE, port);

    await rm(pair.keyFile);
    await waitFor(async () => errors.length, (count) => count > 0);

    expect(await servedFingerprint(REMOTE, port)).toBe(before);
    expect((await sendRemote("GET", "/health", bearer())).status).toBe(200);
    await expect(send(REMOTE, port, "GET", "/health", bearer())).rejects.toThrow(/socket hang up|ECONNRESET/);
  });

  it("closes both listeners and releases the pid file", async () => {
    await startRemote();

    await handle!.close();
    handle = null;

    expect(await canBind("127.0.0.1", port)).toBe(true);
    expect(await canBind(REMOTE, port)).toBe(true);
    expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
  });

  it("still reports a port as unbindable while a listener on it never closes", async () => {
    const leaked = await holdPort("127.0.0.1");

    try {
      expect(await canBind("127.0.0.1", leaked.port, 150)).toBe(false);
    } finally {
      await leaked.release();
    }
  });

  it("binds neither when the remote port is taken, and names the remote host", async () => {
    const squatters: Array<() => Promise<void>> = [];
    try {
      const { port: taken, failure } = await failOnProbedPort(async (probed) => {
        squatters.push((await holdPort(REMOTE, probed)).release);
        return startDaemon(options({ port: probed, remote: remoteOptions() }));
      });

      expect(failure).toBeInstanceOf(DaemonPortInUseError);
      expect(failure).toMatchObject({ port: taken, host: REMOTE });
      expect(await canBind("127.0.0.1", taken)).toBe(true);
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    } finally {
      await Promise.all(squatters.map((release) => release()));
    }
  });

  it("answers loopback byte for byte as a daemon without a remote listener does", async () => {
    const probes = async (loopbackPort: number): Promise<string[]> => {
      const replies = [
        await send("127.0.0.1", loopbackPort, "GET", "/version"),
        await send("127.0.0.1", loopbackPort, "POST", "/rpc/greet", { ...json, "x-titan-client": "t" }, '{"name":"same"}'),
        await send("127.0.0.1", loopbackPort, "POST", "/rpc/greet", { ...json, origin: "http://127.0.0.1" }, '{"name":"same"}'),
        await send("127.0.0.1", loopbackPort, "POST", "/rpc/greet", { ...json, origin: "http://evil.example" }, "{}"),
        await send("127.0.0.1", loopbackPort, "GET", "/health", { host: "evil.example" }),
        await send("127.0.0.1", loopbackPort, "GET", "/auth/login"),
        // Uptime changes the length, so /health compares its status and field names only.
        await send("127.0.0.1", loopbackPort, "GET", "/health", { host: "localhost" }).then((r) => ({ status: r.status, headers: {}, body: Object.keys(JSON.parse(r.body)).sort().join() })),
      ];
      return replies.map(({ status, headers, body }) => JSON.stringify({ status, body, headers: { ...headers, date: undefined } }));
    };
    // No reply carries the port, so each daemon takes its own ephemeral one.
    handle = await startDaemon(options());
    const plain = await probes(handle.port);
    await handle.close();
    handle = await startDaemon(options({ remote: remoteOptions() }));
    const withRemote = await probes(handle.port);

    expect(withRemote).toEqual(plain);
  });
});

/** Poll until `done` holds; the reload timer runs on its own clock, so a fixed sleep would be a guess. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
