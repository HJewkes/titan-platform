/**
 * Daemon lifecycle: bind the hono app on loopback, splice in `/mcp`, watch a tree, and
 * own a pid file until shutdown.
 *
 * `startDaemon` returns a handle so tests and embedders can close it; only
 * `runDaemonUntilSignal` waits on signals. Neither calls `process.exit` — the caller
 * decides how the process terminates.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { serve, type ServerType } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Hono } from "hono";
import type { BaseContext } from "@titan-design/registry";
import { EventHub } from "./events.js";
import { watchTree, type TreeWatcher } from "./file-watch.js";
import { buildHttpApp, type HttpAppOptions } from "./http.js";
import { DEFAULT_DAEMON_PORT, daemonPaths, isProcessAlive, readPidFile, removePidFile, writePidFile, type DaemonPaths } from "./lifecycle.js";
import { consoleLogger, type Logger } from "./logger.js";
import { createMcpServer, type McpServerOptions } from "./mcp.js";
import type { SurfaceOptions } from "./surface.js";

export interface StartDaemonOptions<Ctx extends BaseContext = BaseContext> extends SurfaceOptions<Ctx> {
  /** Reported by `/health`, `/version`, and the pid metadata. */
  version: string;
  /** Directory for `daemon.pid` and `daemon.meta.json`; created if missing. */
  stateDir: string;
  /** Defaults to 7400. Pass 0 for an ephemeral port; the handle reports the bound one. */
  port?: number;
  /** Defaults to 127.0.0.1. */
  host?: string;
  /** When set, `/mcp` serves MCP over streamable HTTP with this tool-name prefix. */
  toolPrefix?: string;
  /** MCP handshake identity; defaults to the daemon `name` option or `titan-daemon`. */
  mcpName?: string;
  /** Directory to watch for live reload; each debounced change broadcasts `change` on the hub. */
  watchRoot?: string;
  /** Product state merged into the `/health` payload. */
  health?: () => Record<string, unknown>;
  /** Hook for product-owned routes. */
  mountRoutes?: (app: Hono) => void;
  logger?: Logger;
}

export interface DaemonHandle {
  /** The bound port — the real one when `port: 0` was requested. */
  port: number;
  /** Broadcast to connected `/events` clients. */
  hub: EventHub;
  /** Stop the watcher, close the socket, and release the pid file. Idempotent. */
  close(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number, readonly port: number) {
    super(`Daemon already running (pid ${pid}, port ${port})`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export async function startDaemon<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>): Promise<DaemonHandle> {
  const log = options.logger ?? consoleLogger;
  const paths = daemonPaths(options.stateDir);
  await assertNotAlreadyRunning(paths);

  const hub = new EventHub();
  let boundPort = options.port ?? DEFAULT_DAEMON_PORT;
  let ready = false;
  const app = buildHttpApp({ ...toHttpOptions(options), hub, port: () => boundPort, ready: () => ready });
  const server = await listen(app, options.host ?? "127.0.0.1", boundPort, mcpHandler(options));
  boundPort = boundPortOf(server, boundPort);

  const watcher = startWatcher(options, hub, log);
  await writePidFile(paths, process.pid, { port: boundPort, version: options.version, started: new Date().toISOString() });
  // Only now is a `/health` probe answerable: the pid file exists, so anything that finds
  // the daemon healthy can also find the daemon.
  ready = true;
  log.info({ pid: process.pid, port: boundPort }, "daemon started");

  return { port: boundPort, hub, close: onceAsync(() => shutdown({ server, watcher, paths, log })) };
}

/** Start, then run until SIGTERM/SIGINT, then close. Resolves after shutdown completes. */
export async function runDaemonUntilSignal<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>): Promise<void> {
  const handle = await startDaemon(options);
  const log = options.logger ?? consoleLogger;
  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals): void => {
      log.info({ signal }, "shutting down");
      void handle.close().then(resolve, resolve);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

function toHttpOptions<Ctx extends BaseContext>(
  options: StartDaemonOptions<Ctx>,
): Omit<HttpAppOptions<Ctx>, "port" | "hub" | "ready"> {
  return {
    registry: options.registry,
    createContext: options.createContext,
    formatError: options.formatError,
    version: options.version,
    health: options.health,
    mountRoutes: options.mountRoutes,
  };
}

async function assertNotAlreadyRunning(paths: DaemonPaths): Promise<void> {
  const existing = await readPidFile(paths);
  if (existing && isProcessAlive(existing.pid)) {
    throw new DaemonAlreadyRunningError(existing.pid, existing.meta.port);
  }
  // Stale pid file — clear it so writePidFile lands cleanly. Naming the dead pid keeps
  // the removal scoped to the file we just inspected.
  if (existing) await removePidFile(paths, existing.pid);
}

function startWatcher<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>, hub: EventHub, log: Logger): TreeWatcher | null {
  const root = options.watchRoot;
  if (!root) return null;
  try {
    return watchTree(root, () => hub.broadcast({ event: "change", data: root }), {
      onError: (err) => log.warn({ err }, "file watcher error"),
    });
  } catch (err) {
    // Live reload is a nicety; never let a watcher failure abort the daemon.
    log.warn({ err, root }, "live-reload watcher unavailable");
    return null;
  }
}

function mcpHandler<Ctx extends BaseContext>(
  options: StartDaemonOptions<Ctx>,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null {
  if (options.toolPrefix === undefined) return null;
  const mcpOptions: McpServerOptions<Ctx> = {
    registry: options.registry,
    createContext: options.createContext,
    formatError: options.formatError,
    toolPrefix: options.toolPrefix,
    name: options.mcpName ?? "titan-daemon",
    version: options.version,
  };
  return (req, res) => handleMcpRequest(mcpOptions, req, res);
}

/**
 * Serve one `/mcp` request from a fresh server + transport.
 *
 * This bypasses hono because `StreamableHTTPServerTransport` takes ownership of the raw
 * Node response object. `sessionIdGenerator: undefined` keeps it stateless: every request
 * is self-contained, so no session state outlives the response.
 */
async function handleMcpRequest<Ctx extends BaseContext>(
  options: McpServerOptions<Ctx>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let body: unknown;
  if (req.method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      return;
    }
  }
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function listen(
  app: Hono,
  hostname: string,
  port: number,
  mcp: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null,
): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname, port }, () => resolve(server));
    if (mcp) spliceMcpRoute(server, mcp);
  });
}

/** Route `/mcp` to the transport ahead of hono, falling through for everything else. */
function spliceMcpRoute(server: ServerType, mcp: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void {
  const honoHandler = server.listeners("request")[0] as ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/")) {
      void mcp(req, res).catch((err) => failRequest(res, err));
      return;
    }
    honoHandler?.(req, res);
  });
}

function failRequest(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = 500;
  res.end(String(err));
}

function boundPortOf(server: ServerType, requested: number): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : requested;
}

interface ShutdownParts {
  server: ServerType;
  watcher: TreeWatcher | null;
  paths: DaemonPaths;
  log: Logger;
}

async function shutdown({ server, watcher, paths, log }: ShutdownParts): Promise<void> {
  try {
    watcher?.close();
  } catch (err) {
    log.error({ err }, "error closing file watcher");
  }
  try {
    await closeServer(server);
  } catch (err) {
    log.error({ err }, "error closing server");
  }
  try {
    // Only ours: a supervised successor may already own the pid file.
    await removePidFile(paths, process.pid);
  } catch (err) {
    log.error({ err }, "error removing pid file");
  }
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function onceAsync(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => (pending ??= fn());
}
