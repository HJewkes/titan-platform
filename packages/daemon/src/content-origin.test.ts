import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { SESSION_COOKIE, ensureTokenFile, signSession } from "./auth.js";
import type * as BindGuardModule from "./bind-guard.js";
import { RemoteBindError, assertRemoteHost } from "./bind-guard.js";
import { containedFile } from "./contained-file.js";
import { DaemonPortInUseError, startDaemon, type DaemonHandle, type StartDaemonOptions } from "./daemon.js";
import { fileResponse } from "./file-response.js";
import { daemonPaths, readPidFile } from "./lifecycle.js";
import { silentLogger } from "./logger.js";
import { createTestContext, createTestRegistry, writeSelfSignedCert, type SelfSignedPair, type TestContext } from "./test-fixtures.js";

// 127.0.0.2 is loopback, so it stands in for the LAN address; every other host meets the real check.
vi.mock("./bind-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BindGuardModule>();
  return { ...actual, assertRemoteHost: vi.fn(actual.assertRemoteHost) };
});

const REMOTE = "127.0.0.2";
const FQDN = "lan-box.example.ts.net";
const SECRET_TEXT = "outside-the-build";

let stateDir: string;
let buildRoot: string;
let handle: DaemonHandle | null = null;

/** `GET /sb/*` from the fixture build, the way a product mounts a per-request root. */
function mountBuild(app: Hono): void {
  app.get("/sb/*", async (c) => {
    const found = await containedFile(buildRoot, new URL(c.req.url).pathname.slice("/sb".length));
    if (found.kind === "refused") return c.text("Forbidden", 403);
    if (found.kind === "missing") return c.text("Not found", 404);
    return fileResponse(c.req.raw, found.file, { contentType: found.contentType });
  });
}

function options(overrides: Partial<StartDaemonOptions<TestContext>> = {}): StartDaemonOptions<TestContext> {
  return {
    registry: createTestRegistry(),
    createContext: createTestContext,
    version: "1.2.3",
    stateDir,
    port: 0,
    toolPrefix: "test",
    logger: silentLogger,
    contentOrigin: { port: 0, mountRoutes: mountBuild },
    ...overrides,
  };
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "titan-content-origin-"));
  buildRoot = path.join(stateDir, "build");
  await mkdir(path.join(buildRoot, "assets"), { recursive: true });
  await writeFile(path.join(buildRoot, "iframe.html"), "<!doctype html><title>story</title>");
  await writeFile(path.join(buildRoot, "index.json"), "{}");
  await writeFile(path.join(buildRoot, "assets", "a-hash.js"), "export {}");
  await writeFile(path.join(stateDir, "secret.txt"), SECRET_TEXT);
  await symlink(path.join(stateDir, "secret.txt"), path.join(buildRoot, "escape.txt"));
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  await rm(stateDir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

function send(address: string, port: number, method: string, route: string, headers: Record<string, string> = {}, body?: string, tls?: { ca: string; servername: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = { host: address, port, path: route, method, headers };
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    };
    const req = tls ? httpsRequest({ ...requestOptions, ...tls }, onResponse) : request(requestOptions, onResponse);
    req.on("error", reject);
    req.end(body);
  });
}

const json = { "content-type": "application/json" };

describe("content origin on loopback", () => {
  const sendContent = (method: string, route: string, headers: Record<string, string> = {}, body?: string) =>
    send("127.0.0.1", handle!.contentPort!, method, route, headers, body);

  it("serves build files on its own port, with their content types", async () => {
    handle = await startDaemon(options());

    const page = await sendContent("GET", "/sb/iframe.html");
    const script = await sendContent("GET", "/sb/assets/a-hash.js");

    expect(handle.contentPort).toBeGreaterThan(0);
    expect(handle.contentPort).not.toBe(handle.port);
    expect(page).toMatchObject({ status: 200, body: "<!doctype html><title>story</title>" });
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  it.each(["POST", "PUT", "DELETE", "OPTIONS"])("answers %s with 405, even with an allowed Origin and a JSON body", async (method) => {
    handle = await startDaemon(options());
    const origin = { origin: `http://127.0.0.1:${handle.contentPort}` };

    // Node's client frames a DELETE or OPTIONS body only with an explicit length.
    const reply = await sendContent(method, "/sb/iframe.html", { ...json, ...origin, "content-length": "2" }, "{}");

    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("GET, HEAD");
  });

  it.each(["/rpc/greet", "/events", "/health", "/version", "/mcp", "/auth/login", "/auth/logout"])("serves no daemon route: GET %s is 404", async (route) => {
    handle = await startDaemon(options());

    expect((await sendContent("GET", route)).status).toBe(404);
  });

  it("refuses a Host naming the main port", async () => {
    handle = await startDaemon(options());

    expect((await sendContent("GET", "/sb/iframe.html", { host: `127.0.0.1:${handle.port}` })).status).toBe(403);
  });

  it("never serves a file outside the build, by encoded .. or by symlink", async () => {
    handle = await startDaemon(options());

    const encoded = await sendContent("GET", "/sb/..%2fsecret.txt");
    const linked = await sendContent("GET", "/sb/escape.txt");

    expect(encoded.status).toBe(403);
    expect(linked.status).toBe(403);
    expect(encoded.body + linked.body).not.toContain(SECRET_TEXT);
  });

  it("is an origin the main loopback listener refuses on a state-changing request", async () => {
    handle = await startDaemon(options());

    const reply = await send("127.0.0.1", handle.port, "POST", "/rpc/greet", { ...json, origin: `http://127.0.0.1:${handle.contentPort}` }, '{"name":"x"}');

    expect(reply.status).toBe(403);
  });

  it("does not start when its port is taken, and releases the main port and pid file", async () => {
    const held = createServer();
    held.listen(0, "127.0.0.1");
    await once(held, "listening");
    const heldPort = (held.address() as AddressInfo).port;
    try {
      const attempt = startDaemon(options({ contentOrigin: { port: heldPort, mountRoutes: mountBuild } }));

      await expect(attempt).rejects.toBeInstanceOf(DaemonPortInUseError);
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    } finally {
      await new Promise((resolve) => held.close(resolve));
    }
  });
});

// Linux routes all of 127/8 to lo; macOS answers only 127.0.0.1 unless an alias is added.
describe.skipIf(process.platform !== "linux")("content origin beside a remote listener (127.0.0.2 stands in for the LAN)", () => {
  let secret: string;
  let pair: SelfSignedPair;

  beforeEach(() => {
    vi.mocked(assertRemoteHost).mockImplementation((host) => {
      if (host !== REMOTE) throw new RemoteBindError(host, "is not the test stand-in");
    });
    const tokenFile = path.join(stateDir, "lan.token");
    secret = ensureTokenFile(tokenFile);
    pair = writeSelfSignedCert(stateDir, [FQDN, REMOTE]);
    return () => vi.mocked(assertRemoteHost).mockReset();
  });

  async function startRemote(): Promise<DaemonHandle> {
    const remote = { host: REMOTE, tokenFile: path.join(stateDir, "lan.token"), tls: { certFile: pair.certFile, keyFile: pair.keyFile }, allowedHosts: [FQDN] };
    handle = await startDaemon(options({ remote }));
    return handle;
  }

  const tls = () => ({ ca: pair.cert, servername: FQDN });
  const cookie = (): Record<string, string> => ({ cookie: `${SESSION_COOKIE}=${signSession(secret)}` });
  const sendContent = (method: string, route: string, headers: Record<string, string> = {}, body?: string) =>
    send(REMOTE, handle!.contentPort!, method, route, headers, body, tls());

  it("answers 401 without the session, and serves with the main listener's cookie", async () => {
    await startRemote();

    const anonymous = await sendContent("GET", "/sb/iframe.html");
    const signedIn = await sendContent("GET", "/sb/iframe.html", cookie());

    expect(anonymous.status).toBe(401);
    expect(anonymous.body).not.toContain("story");
    expect(signedIn).toMatchObject({ status: 200, body: "<!doctype html><title>story</title>" });
  });

  it("has no sign-in route: /auth/login is 401 signed out and 404 signed in", async () => {
    await startRemote();

    expect((await sendContent("GET", "/auth/login?code=x")).status).toBe(401);
    expect((await sendContent("GET", "/auth/login", cookie())).status).toBe(404);
  });

  it.each(["/rpc/greet", "/events", "/health", "/mcp", "/auth/logout"])("serves no daemon route to a signed-in browser: GET %s is 404", async (route) => {
    await startRemote();

    expect((await sendContent("GET", route, cookie())).status).toBe(404);
  });

  it("answers a signed-in POST with 405", async () => {
    await startRemote();
    const origin = { origin: `https://${FQDN}:${handle!.contentPort}` };

    expect((await sendContent("POST", "/sb/iframe.html", { ...json, ...origin, ...cookie() }, "{}")).status).toBe(405);
  });

  it("is an origin the main remote listener refuses, even with the session cookie", async () => {
    await startRemote();
    const reply = await send(REMOTE, handle!.port, "POST", "/rpc/greet", { ...json, ...cookie(), host: `${FQDN}:${handle!.port}`, origin: `https://${FQDN}:${handle!.contentPort}` }, '{"name":"x"}', tls());

    expect(reply.status).toBe(403);
  });
});
