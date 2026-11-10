import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { silentLogger, type Logger } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveFactoryUntilSignal, startFactoryServer, type FactoryServerOptions } from "./serve.js";
import { readPath } from "./narrow.js";
import { landScenario } from "./test-support/land.js";

const FACTORY_DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Serves until SIGTERM through the production entry, which reads LISTEN_FDS and LISTEN_PID itself.
const FIXTURE = `
const { serveFactoryUntilSignal } = await import(process.env.FACTORY_DIST);
const [stateDir, port] = process.argv.slice(1);
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
await serveFactoryUntilSignal({
  dbPath: stateDir + "/factory.sqlite3",
  workflows: [],
  routes: [],
  port: Number(port),
  github: { status: () => "ok", refresh: async () => undefined },
  logger: { info: (fields, message) => console.log(JSON.stringify({ message, ...fields })), warn() {}, error() {} },
}, stop.signal);
process.exit(0);
`;

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-listen-fd-"));
  dirs.push(dir);
  return dir;
}

function options(overrides: Partial<FactoryServerOptions> = {}): FactoryServerOptions {
  const scenario = landScenario();
  return {
    dbPath: join(scratchDir(), "state", "factory.sqlite3"),
    workflows: [scenario.workflow],
    routes: scenario.routes,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    ...overrides,
  };
}

function portOf(server: Server): number {
  const port = readPath(server.address(), "port");
  if (typeof port !== "number") throw new Error("the server is not listening on a port");
  return port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = portOf(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const refuses = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(true));
  });

/** Starts serve as a child whose fd 3 is a listening socket and whose LISTEN_PID is its own pid, as systemd passes it. Only the child owns the socket. */
async function serveOnPassedSocket(requestedPort: number): Promise<{ socketPort: number; started: Record<string, unknown>; child: ChildProcess }> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const socketPort = portOf(socket);
  const script = `LISTEN_FDS=1 LISTEN_PID=$$; export LISTEN_FDS LISTEN_PID; exec "$0" "$@"`;
  const args = ["-c", script, process.execPath, "--input-type=module", "-e", FIXTURE, scratchDir(), String(requestedPort)];
  // node does not type the handle's fd; a spawn takes the number, not the server.
  const fd = readPath(socket, "_handle", "fd");
  if (typeof fd !== "number" || fd < 0) throw new Error("the listening socket has no fd on this platform");
  const child = spawn("sh", args, { env: { ...process.env, FACTORY_DIST }, stdio: ["ignore", "pipe", "inherit", fd] });
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  cleanups.push(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
  });
  return { socketPort, child, started: await startLine(child) };
}

async function startLine(child: ChildProcess): Promise<Record<string, unknown>> {
  let seen = "";
  for await (const chunk of child.stdout!) {
    seen += String(chunk);
    const line = seen.split("\n").find((candidate) => candidate.includes('"daemon started"'));
    if (line) return JSON.parse(line);
  }
  throw new Error("serve exited before it logged daemon started");
}

describe.skipIf(process.platform === "win32")("serve on an inherited listening socket", () => {
  it("answers /health on the passed socket's port, names listenFd, and binds the requested port nowhere", async () => {
    const requested = await freePort();

    const { socketPort, started } = await serveOnPassedSocket(requested);
    const health = await fetch(`http://127.0.0.1:${socketPort}/health`);

    expect(health.ok).toBe(true);
    expect(started).toMatchObject({ port: socketPort, listenFd: 3 });
    expect(await refuses(requested)).toBe(true);
  });

  it("binds the requested port when no fd is passed", async () => {
    const server = await startFactoryServer(options());
    cleanups.push(() => server.close());

    const health = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(health.ok).toBe(true);
  });

  it("ignores LISTEN_FDS when LISTEN_PID names another process", async () => {
    vi.stubEnv("LISTEN_PID", String(process.pid + 1));
    vi.stubEnv("LISTEN_FDS", "1");
    const started: Record<string, unknown>[] = [];
    const logger: Logger = { ...silentLogger, info: (fields, message) => void (message === "daemon started" && started.push(fields)) };

    await serveFactoryUntilSignal(options({ logger }), AbortSignal.abort());

    expect(started).toHaveLength(1);
    expect(started[0]).not.toHaveProperty("listenFd");
    expect(process.env.LISTEN_FDS).toBe("1");
  });
});
