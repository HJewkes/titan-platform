import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { buildHttpApp, type HttpAppOptions } from "./http.js";
import { createTestContext, createTestRegistry, type TestContext } from "./test-fixtures.js";

function buildApp(overrides: Partial<HttpAppOptions<TestContext>> = {}): Hono {
  return buildHttpApp<TestContext>({
    registry: createTestRegistry(),
    createContext: createTestContext,
    version: "1.2.3",
    port: () => 7400,
    ...overrides,
  });
}

const CLI_HEADERS = { "content-type": "application/json", "x-titan-client": "test-cli" };

async function postRpc(app: Hono, name: string, body?: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...CLI_HEADERS, ...(init.headers as Record<string, string> | undefined) };
  return app.request(`/rpc/${name}`, { method: "POST", body, ...init, headers });
}

describe("/health", () => {
  it("answers 503 until the daemon reports ready", async () => {
    let ready = false;
    const app = buildApp({ ready: () => ready });

    const starting = await app.request("/health");
    expect(starting.status).toBe(503);
    expect(await starting.json()).toEqual({ ok: false, starting: true });

    ready = true;
    expect((await app.request("/health")).status).toBe(200);
  });

  it("reports version, port, and the product's health extension", async () => {
    const app = buildApp({ health: () => ({ index: { pending: true } }) });

    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, version: "1.2.3", port: 7400, index: { pending: true } });
    expect(typeof body.uptime_ms).toBe("number");
  });
});

describe("/version", () => {
  it("reports the configured version", async () => {
    const res = await buildApp().request("/version");

    expect(await res.json()).toEqual({ version: "1.2.3" });
  });
});

describe("POST /rpc/:name", () => {
  it("runs the command and returns a success envelope with warnings", async () => {
    const res = await postRpc(buildApp(), "greet", JSON.stringify({ name: "world" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { greeting: "hello world" }, warnings: ["via http"] });
  });

  it("answers 404 for an unknown command", async () => {
    const res = await postRpc(buildApp(), "nope", "{}");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "Unknown command: nope", code: 64 });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await postRpc(buildApp(), "greet", "{not json");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "Invalid JSON body", code: 64 });
  });

  it("answers 400 with DATAERR when args fail the schema", async () => {
    const res = await postRpc(buildApp(), "greet", JSON.stringify({ name: 42 }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: number; error: string };
    expect(body).toMatchObject({ ok: false, code: 65 });
    expect(body.error).toContain("Invalid arguments");
  });

  it("answers 500 with the thrown error's code", async () => {
    const res = await postRpc(buildApp(), "boom", "{}");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "kaboom", code: 78 });
  });

  it("treats a missing body as no arguments", async () => {
    const res = await postRpc(buildApp(), "boom");

    expect(res.status).toBe(500);
  });

  it("applies a product's formatError to thrown errors", async () => {
    const app = buildApp({ formatError: () => ({ message: "redacted", code: 70 }) });

    const res = await postRpc(app, "boom", "{}");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "redacted", code: 70 });
  });
});

describe("request guards", () => {
  it("rejects a non-JSON body on a state-changing request", async () => {
    const res = await postRpc(buildApp(), "greet", "name=world", { headers: { "content-type": "text/plain" } });

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ ok: false, error: "Content-Type must be application/json", code: 64 });
  });

  it("rejects a POST with no Content-Type at all", async () => {
    const res = await buildApp().request("/rpc/boom", { method: "POST", headers: { "x-titan-client": "test-cli" } });

    expect(res.status).toBe(415);
  });

  it("rejects a rebinding-style Host even when the body is JSON", async () => {
    const res = await postRpc(buildApp(), "greet", JSON.stringify({ name: "world" }), {
      headers: { host: "evil.example" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "Host header is not one this daemon answers to", code: 64 });
  });

  it("rejects a foreign Origin on a state-changing request", async () => {
    const res = await postRpc(buildApp(), "greet", JSON.stringify({ name: "world" }), {
      headers: { origin: "http://evil.example" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "Origin is not one this daemon answers to", code: 64 });
  });

  it("rejects an opaque (null) Origin", async () => {
    const res = await postRpc(buildApp(), "greet", JSON.stringify({ name: "world" }), {
      headers: { origin: "null" },
    });

    expect(res.status).toBe(403);
  });

  it("accepts the loopback Origin the daemon is bound to", async () => {
    const res = await postRpc(buildApp(), "greet", JSON.stringify({ name: "world" }), {
      headers: { origin: "http://127.0.0.1:7400", host: "127.0.0.1:7400" },
    });

    expect(res.status).toBe(200);
  });

  it("serves a command with no Origin when the client header names the caller", async () => {
    const res = await postRpc(buildApp(), "greet", JSON.stringify({ name: "cli" }));

    expect(res.status).toBe(200);
  });

  it("refuses a command with neither an Origin nor the client header", async () => {
    const res = await buildApp().request("/rpc/greet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "anon" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      error: "State-changing request needs an Origin header or an X-Titan-Client header",
      code: 64,
    });
  });

  it("treats a blank client header as absent", async () => {
    const res = await postRpc(buildApp(), "greet", "{}", { headers: { "x-titan-client": "  " } });

    expect(res.status).toBe(403);
  });

  it("does not let the client header excuse a foreign Origin", async () => {
    const res = await postRpc(buildApp(), "greet", "{}", { headers: { origin: "http://evil.example" } });

    expect(res.status).toBe(403);
  });

  it.each(["PUT", "PATCH", "DELETE"])("requires Origin or the client header on a product %s route", async (method) => {
    const app = buildApp({ mountRoutes: (a) => a.on(method, "/thing", (c) => c.json({ ok: true })) });
    const headers = { "content-type": "application/json" };

    const anonymous = await app.request("/thing", { method, headers, body: "{}" });
    const named = await app.request("/thing", { method, headers: { ...headers, "x-titan-client": "t" }, body: "{}" });

    expect(anonymous.status).toBe(403);
    expect(named.status).toBe(200);
  });

  it("keeps /health and /version reachable from an allowed host", async () => {
    const app = buildApp();

    expect((await app.request("/health", { headers: { host: "127.0.0.1:7400" } })).status).toBe(200);
    expect((await app.request("/version", { headers: { host: "[::1]:7400" } })).status).toBe(200);
  });

  it("guards reads too, so a rebound page cannot even poll /health", async () => {
    const res = await buildApp().request("/health", { headers: { host: "evil.example" } });

    expect(res.status).toBe(403);
  });

  it("honours a product's own allowlist", async () => {
    const app = buildApp({ guards: { allowedHosts: ["daemon.internal"], allowedOrigins: ["https://console.internal"] } });

    const allowed = await postRpc(app, "greet", JSON.stringify({ name: "ops" }), {
      headers: { host: "daemon.internal", origin: "https://console.internal" },
    });
    expect(allowed.status).toBe(200);
    expect((await postRpc(app, "greet", "{}", { headers: { host: "localhost" } })).status).toBe(403);
  });
});

describe("mountRoutes", () => {
  it("lets a product add its own routes", async () => {
    const app = buildApp({ mountRoutes: (a) => a.get("/ui", (c) => c.text("dashboard")) });

    const res = await app.request("/ui");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dashboard");
  });
});
