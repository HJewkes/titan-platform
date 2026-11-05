import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { REPO } from "../test-support/land.js";
import { portOf } from "../test-support/fakes.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)))));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return portOf(server);
}

const registered = { ok: true, data: { runId: "run-1", created: true } };

/** Answers /health and /rpc only after `delayMs`, the way a serve does while its event loop is busy. */
const slowServe = (delayMs: number) =>
  listen((req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/health" ? { status: "ok" } : registered));
    }, delayMs);
  });

async function deadPort(): Promise<number> {
  const probe = createSocketServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = portOf(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

interface Registered {
  code: number;
  out: string;
  err: string;
}

async function register(port: number, serveWaitMs: number): Promise<Registered> {
  const fixture = shepherdFixture({ frozen: true });
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: {} };
  const argv = ["shepherd", "register", `${REPO}#1`, "--task", "demo/T-1", "--implementer", "impl-a", "--json", "--port", String(port)];
  const code = await runCli(argv, io, { workflows: fixture.workflows, routes: fixture.routes, logger: silentLogger, serveWaitMs });
  return { code, out, err };
}

/** The register's result once it lands inside the wait budget; a probe that waited out a longer bound fails the wait by name. */
async function settledRegister(port: number, serveWaitMs: number): Promise<Registered> {
  let result: Registered | undefined;
  void register(port, serveWaitMs).then((done) => (result = done));
  await vi.waitFor(() => expect(result).toBeDefined());
  return result!;
}

describe("shepherd register against a serve that is busy rather than down", () => {
  it("gets the answer from a serve that replies slower than the old half-second probe", async () => {
    const port = await slowServe(800);

    const result = await register(port, 3000);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ runId: "run-1" });
  });

  it("exits 69 saying the serve is busy when it accepts the connection but never answers", async () => {
    const port = await slowServe(60_000);

    const result = await settledRegister(port, 300);

    expect(result.code).toBe(69);
    expect(result.err).toMatch(/did not answer within 0.3 s/);
    expect(result.err).not.toMatch(/refused/);
  });

  it("exits 69 quickly saying the connection was refused when nothing is listening", async () => {
    const port = await deadPort();

    const result = await settledRegister(port, 60_000);

    expect(result.code).toBe(69);
    expect(result.err).toMatch(/connection refused/);
  });
});
