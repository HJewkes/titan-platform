import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { containedFile } from "./contained-file.js";
import { DaemonPortInUseError, startDaemon, type DaemonHandle, type StartDaemonOptions } from "./daemon.js";
import { fileResponse } from "./file-response.js";
import { daemonPaths, readPidFile } from "./lifecycle.js";
import { silentLogger } from "./logger.js";
import { createTestContext, createTestRegistry, type TestContext } from "./test-fixtures.js";

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
    const address = held.address();
    if (address === null || typeof address === "string") throw new Error("the held server has no port");
    const heldPort = address.port;
    try {
      const attempt = startDaemon(options({ contentOrigin: { port: heldPort, mountRoutes: mountBuild } }));

      await expect(attempt).rejects.toBeInstanceOf(DaemonPortInUseError);
      expect(await readPidFile(daemonPaths(stateDir))).toBeNull();
    } finally {
      await new Promise((resolve) => held.close(resolve));
    }
  });
});
