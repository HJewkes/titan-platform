import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { silentLogger } from "./logger.js";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { buildHttpApp } from "./http.js";
import { mountStaticApp, requestSegments, type StaticAppOptions } from "./static-app.js";
import { createTestContext, createTestRegistry } from "./test-fixtures.js";

let dir: string;
let root: string;
const SECRET = "outside-the-root";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "static-app-"));
  root = path.join(dir, "dist");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>app</title>");
  await writeFile(path.join(root, "assets", "index-B1a2c3D4.js"), "console.log('app')");
  await writeFile(path.join(root, "assets", "index-9zYxWv8u.css"), "body{}");
  await writeFile(path.join(root, "favicon.svg"), "<svg/>");
  await writeFile(path.join(root, ".env"), "TOKEN=1");
  await writeFile(path.join(dir, "secret.txt"), SECRET);
  await symlink(path.join(dir, "secret.txt"), path.join(root, "escape.txt"));
  await symlink(dir, path.join(root, "up"));
  await symlink(path.join(root, "favicon.svg"), path.join(root, "alias.svg"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function appWith(options: Partial<StaticAppOptions> = {}) {
  return buildHttpApp({
    registry: createTestRegistry(),
    createContext: createTestContext,
    version: "1.0.0",
    port: () => 7400,
    mountRoutes: (app) => mountStaticApp(app, { root, base: "/ui", ...options }),
  });
}

const get = (url: string, host = "127.0.0.1:7400") => appWith().request(url, { headers: { host } });

describe("mountStaticApp", () => {
  it("serves hashed assets with their type and a year-long immutable cache", async () => {
    const js = await get("/ui/assets/index-B1a2c3D4.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get("/ui/assets/index-9zYxWv8u.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("makes index.html and unhashed files revalidate", async () => {
    const index = await get("/ui/");
    expect(await index.text()).toContain("<title>app</title>");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect((await get("/ui/favicon.svg")).headers.get("cache-control")).toBe("no-cache");
  });

  it("answers a client route with index.html, and a missing asset with 404", async () => {
    const route = await get("/ui/reports/42?tab=files");
    expect(route.status).toBe(200);
    expect(route.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect((await get("/ui/assets/gone-AAAAAAAA.js")).status).toBe(404);
  });

  it("redirects the bare prefix to its trailing-slash form", async () => {
    const res = await get("/ui?x=1");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/ui/?x=1");
  });

  it("follows a symlink that stays inside the root", async () => {
    expect(await (await get("/ui/alias.svg")).text()).toBe("<svg/>");
  });

  it("never serves a dotfile's contents", async () => {
    const res = await get("/ui/.env");
    expect(await res.text()).not.toContain("TOKEN");
  });

  it("serves a single-file build for every client route", async () => {
    const single = buildHttpApp({
      registry: createTestRegistry(),
      createContext: createTestContext,
      version: "1.0.0",
      port: () => 7400,
      mountRoutes: (app) => mountStaticApp(app, { root: path.join(root, "index.html") }),
    });
    const res = await single.request("/deep/link", { headers: { host: "127.0.0.1:7400" } });
    expect(await res.text()).toContain("<title>app</title>");
    expect((await single.request("/health", { headers: { host: "127.0.0.1:7400" } })).headers.get("content-type")).toMatch(/json/);
  });

  it("says the app is not built, with 503, until index.html exists", async () => {
    const res = await appWith({ root: path.join(dir, "missing") }).request("/ui/", { headers: { host: "127.0.0.1:7400" } });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("has not been built");
  });

  it("stays behind the daemon's Host guard", async () => {
    expect((await get("/ui/", "evil.test:7400")).status).toBe(403);
  });

  it("leaves the /rpc guards as they were", async () => {
    const app = appWith({ base: "/" });
    const headers = { host: "127.0.0.1:7400", origin: "http://evil.test", "content-type": "application/json" };
    const refused = await app.request("/rpc/greet", { method: "POST", headers, body: '{"name":"x"}' });
    expect(refused.status).toBe(403);
    const plain = await app.request("/rpc/greet", { method: "POST", headers: { host: "127.0.0.1:7400", "x-titan-client": "test" }, body: '{"name":"x"}' });
    expect(plain.status).toBe(415);
  });
});

describe("requestSegments", () => {
  it.each([
    ["/a/b.js", ["a", "b.js"]],
    ["/a%20b/c", ["a b", "c"]],
    ["//a///b", ["a", "b"]],
  ])("splits %s into decoded segments", (input, expected) => {
    expect(requestSegments(input)).toEqual(expected);
  });

  it.each(["/..", "/a/../b", "/%2e%2e/x", "/a%2f..%2fb", "/a%5c..%5cb", "/%00", "/C:%5cwindows", "/%E0%A4%A"])("refuses %s", (input) => {
    expect(requestSegments(input)).toBeNull();
  });
});

interface Reply {
  status: number;
  body: string;
}

/** Raw bytes on the wire, because fetch and URL would normalise a `..` before it left the client. */
function rawGet(port: number, target: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: target, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("traversal against a real daemon", () => {
  let handle: DaemonHandle;

  beforeAll(async () => {
    handle = await startDaemon({
      registry: createTestRegistry(),
      createContext: createTestContext,
      version: "1.0.0",
      stateDir: path.join(dir, "state"),
      port: 0,
      logger: silentLogger,
      mountRoutes: (app) => mountStaticApp(app, { root, base: "/ui" }),
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  // The URL parser folds a plain or %2e dot segment before routing, so those never reach /ui (404).
  it.each([
    ["/ui/../secret.txt", 404],
    ["/ui/../../../../etc/passwd", 404],
    ["/ui/%2e%2e/secret.txt", 404],
    ["/ui/%2E%2E%2Fsecret.txt", 403],
    ["/ui/..%2fsecret.txt", 403],
    ["/ui/..%5csecret.txt", 403],
    ["/ui/%2Fetc%2Fpasswd", 403],
    ["/ui/escape.txt", 403],
    ["/ui/up/secret.txt", 403],
    ["/ui//etc/passwd", 200],
  ])("answers %s with %i and never the file", async (target, status) => {
    const reply = await rawGet(handle.port, target);
    expect(reply.status).toBe(status);
    expect(reply.body).not.toContain(SECRET);
    expect(reply.body).not.toContain("root:");
    if (status === 200) expect(reply.body).toBe("<!doctype html><title>app</title>");
  });

  it("serves the app itself over the same socket", async () => {
    expect((await rawGet(handle.port, "/ui/assets/index-B1a2c3D4.js")).body).toBe("console.log('app')");
  });
});
