import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const DAEMON_DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const REGISTRY_DIST = fileURLToPath(new URL("../../registry/dist/index.js", import.meta.url));

// Starts on the inherited socket and reports what startDaemon threw, if anything.
const FIXTURE = `
const { startDaemon, silentLogger, systemdListenFd } = await import(process.env.DAEMON_DIST);
const { createRegistry } = await import(process.env.REGISTRY_DIST);
try {
  const handle = await startDaemon({
    registry: createRegistry(),
    createContext: () => ({ warnings: [], format: "json" }),
    version: "listen-fd-address",
    stateDir: process.argv[1],
    logger: silentLogger,
    listenFd: systemdListenFd(),
    port: 0,
  });
  console.log("started");
  await handle.close();
} catch (err) {
  console.log(err.name);
}
process.exit(0);
`;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fdOf(server: Server): number {
  const handle: unknown = Reflect.get(server, "_handle");
  const fd: unknown = typeof handle === "object" && handle !== null ? Reflect.get(handle, "fd") : undefined;
  if (typeof fd !== "number" || fd < 0) throw new Error("the listening socket has no fd on this platform");
  return fd;
}

/** Runs the fixture as a child whose fd 3 is a socket listening on `host`, with LISTEN_PID its own pid, as systemd passes it. */
async function startOnSocketBoundTo(host: string): Promise<{ outcome: string; stateDir: string }> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "listen-fd-address-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, host, resolve));
  const script = `LISTEN_FDS=1 LISTEN_PID=$$; export LISTEN_FDS LISTEN_PID; exec "$0" "$@"`;
  const args = ["-c", script, process.execPath, "--input-type=module", "-e", FIXTURE, stateDir];
  const child = spawn("sh", args, { env: { ...process.env, DAEMON_DIST, REGISTRY_DIST }, stdio: ["ignore", "pipe", "inherit", fdOf(socket)] });
  let out = "";
  child.stdout?.on("data", (chunk) => void (out += String(chunk)));
  await once(child, "exit");
  socket.close();
  return { outcome: out.trim(), stateDir };
}

describe.skipIf(process.platform === "win32")("startDaemon on an inherited socket's real address", () => {
  it("refuses a socket listening on every interface and writes no pid file", async () => {
    const { outcome, stateDir } = await startOnSocketBoundTo("0.0.0.0");

    expect(outcome).toBe("NonLoopbackBindError");
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("serves on a loopback socket", async () => {
    const { outcome } = await startOnSocketBoundTo("127.0.0.1");

    expect(outcome).toBe("started");
  });
});
