import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeHttp, type ProbeHttpDeps, type ProbeHttpTarget } from "./index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(status: number, body: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${port}/health`;
}

function target(url: string, extra: Partial<ProbeHttpTarget> = {}): ProbeHttpTarget {
  return { name: "factory", url, timeoutMs: 2000, ...extra };
}

const SERVE_HEALTH = {
  ok: true,
  pid: 4242,
  port: 7410,
  restartCount: 3,
  build: { sha: "abc123" },
};

describe("probeHttp against a server that answers", () => {
  it("reads a health/v1 status and records the HTTP code", async () => {
    const url = await serve(200, JSON.stringify({ status: "warn", checks: { db: { status: "warn" } } }));

    const sample = await probeHttp(target(url));

    expect(sample).toMatchObject({ target: "factory", kind: "http", status: "warn", observed: { code: 200 } });
    expect(sample.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reads a legacy ok payload as pass", async () => {
    const url = await serve(200, JSON.stringify(SERVE_HEALTH));

    const sample = await probeHttp(target(url), { expectedPid: async () => 4242 });

    expect(sample.status).toBe("pass");
  });

  it("reads a non-2xx answer as fail with its code", async () => {
    const url = await serve(503, JSON.stringify({ status: "fail" }));

    const sample = await probeHttp(target(url));

    expect(sample).toMatchObject({ status: "fail", observed: { code: 503 } });
  });

  it("reads a body that is not JSON as fail", async () => {
    const url = await serve(200, "<html>proxy</html>");

    const sample = await probeHttp(target(url));

    expect(sample).toMatchObject({ status: "fail", observed: { code: 200 } });
    expect(sample.output).toMatch(/not JSON/);
  });

  it("reads JSON that is not a health payload as fail", async () => {
    const url = await serve(200, JSON.stringify({ hello: "world" }));

    const sample = await probeHttp(target(url));

    expect(sample.status).toBe("fail");
    expect(sample.output).toMatch(/payload/);
  });
});

describe("probeHttp identity", () => {
  it("fails a 200 whose pid is not the expected pid", async () => {
    const url = await serve(200, JSON.stringify(SERVE_HEALTH));

    const sample = await probeHttp(target(url), { expectedPid: async () => 999 });

    expect(sample.status).toBe("fail");
    expect(sample.output).toMatch(/^identity: /);
  });

  it("fails a 200 when the pid file is missing", async () => {
    const url = await serve(200, JSON.stringify(SERVE_HEALTH));

    const sample = await probeHttp(target(url), { expectedPid: async () => null });

    expect(sample.status).toBe("fail");
    expect(sample.output).toMatch(/^identity: /);
  });

  it("fails a 200 that reports no pid when a pid is expected", async () => {
    const url = await serve(200, JSON.stringify({ ok: true }));

    const sample = await probeHttp(target(url), { expectedPid: async () => 4242 });

    expect(sample.status).toBe("fail");
    expect(sample.output).toMatch(/^identity: /);
  });

  it("fails a 200 whose port is not the expected port", async () => {
    const url = await serve(200, JSON.stringify(SERVE_HEALTH));

    const sample = await probeHttp(target(url, { expectPort: 7411 }));

    expect(sample.status).toBe("fail");
    expect(sample.output).toMatch(/^identity: .*port/);
  });

  it("passes when both pid and port match", async () => {
    const url = await serve(200, JSON.stringify(SERVE_HEALTH));

    const sample = await probeHttp(target(url, { expectPort: 7410 }), { expectedPid: async () => 4242 });

    expect(sample.status).toBe("pass");
  });

  it("reads an expectedPid that throws as unknown, never pass", async () => {
    const url = await serve(200, JSON.stringify(SERVE_HEALTH));

    const sample = await probeHttp(target(url), {
      expectedPid: async () => {
        throw new Error("EACCES");
      },
    });

    expect(sample.status).toBe("unknown");
    expect(sample.output).toMatch(/EACCES/);
  });
});

describe("probeHttp when the target is down", () => {
  it("reads connection refused as fail without throwing", async () => {
    const url = await closedPortUrl();

    const sample = await probeHttp(target(url));

    expect(sample.status).toBe("fail");
    expect(sample.observed?.code).toBeUndefined();
    expect(sample.output).toMatch(/^unreachable/);
  });

  it("reads a fetch that never answers as fail once the clock passes the timeout", async () => {
    const pending: Array<() => void> = [];
    const deps: ProbeHttpDeps = {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      after: (_ms, fire) => {
        pending.push(fire);
        return () => {};
      },
    };

    const probe = probeHttp(target("http://127.0.0.1:1/health", { timeoutMs: 250 }), deps);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.();
    const sample = await probe;

    expect(sample).toMatchObject({ status: "fail", output: "timeout after 250 ms" });
  });

  it("times out a server that sends headers and then stalls mid-body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":');
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;

    const sample = await probeHttp(target(url, { timeoutMs: 100 }));
    server.closeAllConnections();

    expect(sample).toMatchObject({ status: "fail", output: "timeout after 100 ms" });
  });

  it("reads a redirect as fail instead of following it", async () => {
    const landing = await serve(200, JSON.stringify({ ok: true }));
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: landing });
      res.end();
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;

    const sample = await probeHttp(target(url));

    expect(sample).toMatchObject({ status: "fail", observed: { code: 302 } });
  });

  it("reads a URL that does not parse as unknown", async () => {
    const sample = await probeHttp(target("not a url"));

    expect(sample.status).toBe("unknown");
  });
});

describe("probeHttp measurements", () => {
  it("measures latency with the injected clock, from before fetch to after the body", async () => {
    let clock = 1_700_000_000_000;
    const deps: ProbeHttpDeps = {
      now: () => clock,
      fetch: async () => {
        clock += 40;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };

    const sample = await probeHttp(target("http://127.0.0.1:7410/health"), deps);

    expect(sample.latencyMs).toBe(40);
    expect(sample.ts).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("leaves the pid lookup out of the latency", async () => {
    let clock = 1_700_000_000_000;
    const deps: ProbeHttpDeps = {
      now: () => clock,
      fetch: async () => {
        clock += 40;
        return new Response(JSON.stringify({ ok: true, pid: 7 }), { status: 200 });
      },
      expectedPid: async () => {
        clock += 500;
        return 7;
      },
    };

    const sample = await probeHttp(target("http://127.0.0.1:7410/health"), deps);

    expect(sample).toMatchObject({ status: "pass", latencyMs: 40 });
  });

  it("copies observe paths and omits a missing path rather than defaulting it", async () => {
    const url = await serve(200, JSON.stringify(SERVE_HEALTH));

    const sample = await probeHttp(target(url, { observe: ["build.sha", "restartCount", "uncleanStartsTotal"] }));

    expect(sample.observed).toEqual({ code: 200, "build.sha": "abc123", restartCount: 3 });
  });
});
