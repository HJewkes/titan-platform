import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DAEMON_DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const REGISTRY_DIST = fileURLToPath(new URL("../../registry/dist/index.js", import.meta.url));

// Serves until SIGTERM, on the inherited socket ("fd") or by binding the port itself ("port").
const FIXTURE = `
const { runDaemonUntilSignal, silentLogger, systemdListenFd } = await import(process.env.DAEMON_DIST);
const { createRegistry } = await import(process.env.REGISTRY_DIST);
const [mode, port, stateDir] = process.argv.slice(2);
const listen = mode === "fd" ? { listenFd: systemdListenFd(), port: 0 } : { port: Number(port) };
await runDaemonUntilSignal({
  registry: createRegistry(),
  createContext: () => ({ warnings: [], format: "json" }),
  version: "listen-fd",
  stateDir,
  logger: silentLogger,
  ...listen,
});
process.exit(0);
`;

// Stands in for systemd: keeps fd 3 open, never accepts, and starts or stops one daemon per line.
// The inner sh execs node, so $$ there is node's pid, as LISTEN_PID must be.
const HOLDER = `
pid=
while read -r cmd mode arg; do
  case "$cmd" in
    start)
      sh -c 'LISTEN_FDS=1 LISTEN_PID=$$; export LISTEN_FDS LISTEN_PID; exec "$0" "$@"' "$NODE" "$FIXTURE" "$mode" "$arg" "$STATE_DIR" </dev/null &
      pid=$!
      echo "$pid" ;;
    stop)
      kill -TERM "$pid"
      wait "$pid"
      echo "$pid" ;;
  esac
done
`;

interface Outcome {
  status?: number;
  pid?: number;
  error?: string;
}

class Holder {
  readonly started: number[] = [];
  private readonly lines: Interface;
  private readonly stdin: Writable;

  constructor(private readonly child: ChildProcess) {
    if (!child.stdin || !child.stdout) throw new Error("the holder needs piped stdin and stdout");
    this.stdin = child.stdin;
    this.lines = createInterface({ input: child.stdout });
  }

  async start(mode: "fd" | "port", port: number): Promise<number> {
    const pid = await this.send(`start ${mode} ${port}`);
    this.started.push(pid);
    return pid;
  }

  stop(): Promise<number> {
    return this.send("stop");
  }

  kill(): void {
    for (const pid of this.started) signal(pid);
    if (this.child.pid !== undefined) signal(this.child.pid);
  }

  private async send(command: string): Promise<number> {
    const reply = once(this.lines, "line");
    this.stdin.write(`${command}\n`);
    const [line]: unknown[] = await reply;
    return Number(line);
  }
}

function signal(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

let dir: string;
const holders: Holder[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "listen-fd-"));
  writeFileSync(path.join(dir, "fixture.mjs"), FIXTURE);
});

afterEach(() => {
  for (const holder of holders.splice(0)) holder.kill();
  rmSync(dir, { recursive: true, force: true });
});

function spawnHolder(socket?: Server): Holder {
  const env = { ...process.env, NODE: process.execPath, FIXTURE: path.join(dir, "fixture.mjs"), STATE_DIR: dir, DAEMON_DIST, REGISTRY_DIST };
  const extra = socket ? [listeningFd(socket)] : [];
  const child = spawn("sh", ["-c", HOLDER], { env, stdio: ["pipe", "pipe", "inherit", ...extra] });
  const holder = new Holder(child);
  holders.push(holder);
  return holder;
}

/**
 * net.Server exposes no public fd, and spawn() rejects the server itself in stdio; the
 * handle's fd number is what it dups into the child as fd 3.
 */
function listeningFd(server: Server): number {
  const handle: unknown = Reflect.get(server, "_handle");
  const fd: unknown = typeof handle === "object" && handle !== null ? Reflect.get(handle, "fd") : undefined;
  if (typeof fd !== "number") throw new Error("the listening socket exposes no fd");
  return fd;
}

async function listeningSocket(): Promise<Server> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the socket has no TCP address");
  return address.port;
}

function pidOf(body: string): number | undefined {
  const parsed: unknown = JSON.parse(body);
  const pid: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "pid") : undefined;
  return typeof pid === "number" ? pid : undefined;
}

async function freePort(): Promise<number> {
  const server = await listeningSocket();
  const port = portOf(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function probe(port: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 10_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, pid: pidOf(body) }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
  });
}

/** One `/health` request every 20 ms, each on a fresh connection, until stopped. */
function pollHealth(port: number): { seen: Set<number>; stop: () => Promise<Outcome[]> } {
  const seen = new Set<number>();
  const pending: Promise<Outcome>[] = [];
  const timer = setInterval(() => {
    pending.push(probe(port).then((outcome) => (outcome.pid !== undefined && seen.add(outcome.pid), outcome)));
  }, 20);
  return { seen, stop: () => (clearInterval(timer), Promise.all(pending)) };
}

/** Start A, load it, stop A, start B, and keep loading until B has answered for 500 ms. */
async function restartUnderLoad(holder: Holder, mode: "fd" | "port", port: number): Promise<{ pids: number[]; outcomes: Outcome[] }> {
  const a = await holder.start(mode, port);
  await vi.waitFor(async () => expect((await probe(port)).status).toBe(200), { timeout: 10_000, interval: 50 });
  const load = pollHealth(port);
  await delay(200);
  await holder.stop();
  const b = await holder.start(mode, port);
  await vi.waitFor(() => expect(load.seen.has(b)).toBe(true), { timeout: 10_000, interval: 20 });
  await delay(500);
  const outcomes = await load.stop();
  await holder.stop();
  return { pids: [a, b], outcomes };
}

const refusals = (outcomes: Outcome[]): number => outcomes.filter((o) => o.error === "ECONNREFUSED").length;

describe.skipIf(process.platform === "win32")("a daemon restarted on an inherited listening socket", () => {
  it("answers every request across the restart, refusing none", async () => {
    const socket = await listeningSocket();
    const port = portOf(socket);
    const holder = spawnHolder(socket);
    // The holder is now the socket's only owner, as systemd is.
    await new Promise((resolve) => socket.close(resolve));

    const { pids, outcomes } = await restartUnderLoad(holder, "fd", port);

    expect(refusals(outcomes)).toBe(0);
    expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
    expect(new Set(outcomes.map((o) => o.pid))).toEqual(new Set(pids));
  }, 30_000);

  it("refuses connections across the same restart when each daemon binds the port itself", async () => {
    const port = await freePort();
    const holder = spawnHolder();

    const { outcomes } = await restartUnderLoad(holder, "port", port);

    expect(refusals(outcomes)).toBeGreaterThan(0);
  }, 30_000);
});
