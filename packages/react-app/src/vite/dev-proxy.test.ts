import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type ServerOptions, type ViteDevServer } from "vite";
import { createTestRegistry, startTestDaemon, type TestDaemon } from "../test-fixtures.js";
import { daemonHeaders, isLoopbackHost, titanApp } from "./index.js";

interface Reply {
  status: number;
  body: string;
}

/** node:http rather than fetch, so a test can send any Host and Origin a browser or attacker could. */
function send(port: number, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (pathname.startsWith("/events")) req.destroy();
      });
      res.on("close", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", (err) => (pathname.startsWith("/events") ? undefined : reject(err)));
    req.end(body);
  });
}

async function startVite(root: string, daemon: TestDaemon, server: ServerOptions = {}): Promise<ViteDevServer> {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: titanApp({ daemonUrl: daemon.origin }),
    server: { port: 0, host: "127.0.0.1", ...server },
  });
  return vite.listen();
}

const portOf = (vite: ViteDevServer): number => (vite.httpServer!.address() as { port: number }).port;

describe("daemonHeaders", () => {
  const daemon = new URL("http://127.0.0.1:7400");

  it("turns a same-origin loopback request into a same-origin daemon request", () => {
    expect(daemonHeaders({ host: "localhost:5173", origin: "http://localhost:5173" }, daemon)).toEqual({
      host: "127.0.0.1:7400",
      origin: "http://127.0.0.1:7400",
    });
  });

  it("rewrites Host but keeps a foreign Origin, so the daemon refuses it", () => {
    expect(daemonHeaders({ host: "localhost:5173", origin: "http://evil.test" }, daemon)).toEqual({ host: "127.0.0.1:7400" });
  });

  it("leaves a request that reached the dev server by a non-loopback name untouched", () => {
    expect(daemonHeaders({ host: "evil.test:5173", origin: "http://evil.test:5173" }, daemon)).toEqual({});
  });

  it.each([
    ["localhost:5173", true],
    ["127.0.0.1", true],
    ["[::1]:5173", true],
    ["LOCALHOST:1", true],
    ["localhost.evil.test:5173", false],
    ["127.0.0.1.nip.io", false],
  ])("treats %s as loopback: %s", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});

describe("the dev server in front of a real daemon", () => {
  let daemon: TestDaemon;
  let vite: ViteDevServer;
  let root: string;
  let port: number;
  const json = { "content-type": "application/json" };

  beforeAll(async () => {
    daemon = await startTestDaemon(createTestRegistry());
    root = await mkdtemp(path.join(tmpdir(), "react-app-vite-"));
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>dev</title>");
    await writeFile(path.join(root, "rpc.ts"), "export const local = true;");
    vite = await startVite(root, daemon);
    port = portOf(vite);
  });

  afterAll(async () => {
    await vite.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  it("forwards a same-origin command call through the daemon's guards", async () => {
    const host = `localhost:${port}`;
    const reply = await send(port, "POST", "/rpc/note.list", { ...json, host, origin: `http://${host}` }, "{}");
    expect(reply).toEqual({ status: 200, body: '{"ok":true,"data":{"ids":["n1","n2","n3"]}}' });
  });

  it("forwards /health and the event stream", async () => {
    const host = `localhost:${port}`;
    expect((await send(port, "GET", "/health", { host })).status).toBe(200);
    expect((await send(port, "GET", "/events", { host })).body).toContain("event: ready");
  });

  it("lets the daemon refuse a cross-origin page's call", async () => {
    const reply = await send(port, "POST", "/rpc/note.list", { ...json, host: `localhost:${port}`, origin: "http://evil.test" }, "{}");
    expect(reply.status).toBe(403);
    expect(reply.body).toContain("Origin is not one this daemon answers to");
  });

  it("lets the daemon refuse a call without a JSON body type", async () => {
    const host = `localhost:${port}`;
    const reply = await send(port, "POST", "/rpc/note.list", { host, origin: `http://${host}`, "content-type": "text/plain" }, "{}");
    expect(reply.status).toBe(415);
  });

  it("refuses a DNS-rebound name before the daemon sees it", async () => {
    const reply = await send(port, "GET", "/health", { host: `evil.test:${port}` });
    expect(reply.status).toBe(403);
    expect(reply.body).toContain("Blocked request");
  });

  it("still lets the daemon refuse a rebound name when the dev server accepts any host", async () => {
    const open = await startVite(root, daemon, { allowedHosts: true });
    try {
      const reply = await send(portOf(open), "GET", "/health", { host: `evil.test:${portOf(open)}` });
      expect(reply.status).toBe(403);
      expect(reply.body).toContain("Host header is not one this daemon answers to");
    } finally {
      await open.close();
    }
  });

  it("serves a source module whose name starts with a proxied route", async () => {
    const reply = await send(port, "GET", "/rpc.ts", { host: `localhost:${port}` });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("local");
  });
});
