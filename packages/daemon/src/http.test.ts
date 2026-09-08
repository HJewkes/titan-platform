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

async function postRpc(app: Hono, name: string, body?: string): Promise<Response> {
  return app.request(`/rpc/${name}`, { method: "POST", body });
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

describe("mountRoutes", () => {
  it("lets a product add its own routes", async () => {
    const app = buildApp({ mountRoutes: (a) => a.get("/ui", (c) => c.text("dashboard")) });

    const res = await app.request("/ui");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dashboard");
  });
});
