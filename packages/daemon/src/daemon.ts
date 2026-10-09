/**
 * Daemon lifecycle: bind the hono app on loopback, splice in `/mcp`, optionally open a second,
 * authenticated listener on one LAN address, watch a tree, and own a pid file until shutdown.
 *
 * `startDaemon` returns a handle so tests and embedders can close it; only
 * `runDaemonUntilSignal` waits on signals. Neither calls `process.exit` — the caller
 * decides how the process terminates.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIPv6 } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { BaseContext } from "@titan-design/registry";
import { createDaemonAuth, type DaemonAuth } from "./auth.js";
import { assertRemoteHost, isLoopbackHost, NonLoopbackBindError, RemoteBindError } from "./bind-guard.js";
import { EventHub } from "./events.js";
import { watchTree, type TreeWatcher } from "./file-watch.js";
import { DEFAULT_ALLOWED_HOSTS, createRequestGuard, type RequestGuardOptions } from "./guards.js";
import { buildHttpApp, type HttpAppOptions, type RpcBodyLimit } from "./http.js";
import { DEFAULT_DAEMON_PORT, daemonPaths, getProcessStartTime, isProcessAlive, pidFileModifiedAt, probeHealth, readPidFile, removePidFile, writePidFile, type DaemonPaths, type PidFileContents } from "./lifecycle.js";
import { consoleLogger, type Logger } from "./logger.js";
import type { McpServerOptions } from "./mcp.js";
import { handleMcpRequest, spliceMcpRoute } from "./mcp-http.js";
import type { SurfaceOptions } from "./surface.js";

export interface StartDaemonOptions<Ctx extends BaseContext = BaseContext> extends SurfaceOptions<Ctx> {
  /** Reported by `/health`, `/version`, and the pid metadata. */
  version: string;
  /** Directory for `daemon.pid` and `daemon.meta.json`; created if missing. */
  stateDir: string;
  /** Seam for the stale pid check: when the process at a pid started. Defaults to `ps`. */
  processStartTime?: (pid: number) => Date | null;
  /** Defaults to 7400. Pass 0 for an ephemeral port; the handle reports the bound one. */
  port?: number;
  /** Defaults to 127.0.0.1. A non-loopback host throws `NonLoopbackBindError` unless the opt-in below is set. */
  host?: string;
  /** The daemon has no auth: setting this exposes every route to the network the host is on. */
  allowUnauthenticatedNonLoopback?: boolean;
  /** A second listener, behind authentication, on one non-loopback address and the same port. */
  remote?: RemoteListenerOptions;
  /** When set, `/mcp` serves MCP over streamable HTTP with this tool-name prefix. */
  toolPrefix?: string;
  /** MCP handshake identity; defaults to `titan-daemon`. */
  mcpName?: string;
  /** Directory to watch for live reload; each debounced change broadcasts `change` on the hub. */
  watchRoot?: string;
  /** Product state merged into the `/health` payload. */
  health?: () => Record<string, unknown>;
  /** Hook for product-owned routes. */
  mountRoutes?: (app: Hono) => void;
  /** Host/Origin allowlists and the JSON body gate, shared by the hono routes and `/mcp`. */
  guards?: RequestGuardOptions;
  /** The byte cap on a `/rpc` body on every listener; defaults to 1 MiB for every command. */
  rpcBodyLimit?: RpcBodyLimit;
  /** Grace given to in-flight requests before lingering sockets are destroyed. Defaults to 2000. */
  shutdownGraceMs?: number;
  logger?: Logger;
}

/**
 * The remote listener runs the Host/Origin guard, then the auth gate, before every route, and
 * never serves `/mcp`. Its Host allowlist is `host` plus `allowedHosts` and nothing else, each
 * matched only with the bound port, and its origins are derived from that list alone. The
 * loopback listener is unchanged and never learns these names. `mountRoutes` runs once per
 * listener, each on its own app.
 */
export interface RemoteListenerOptions {
  /** A bare IP address on one of this host's interfaces. Loopback, wildcards and names throw `RemoteBindError`. */
  host: string;
  /** The shared secret. It must already exist; see `ensureTokenFile`. */
  tokenFile: string;
  /** Names the remote listener also answers to, such as a LAN DNS name. */
  allowedHosts?: string[];
}

export interface DaemonHandle {
  /** The bound port — the real one when `port: 0` was requested. */
  port: number;
  /** Broadcast to connected `/events` clients. */
  hub: EventHub;
  /** Stop the watcher, close every listener, and release the pid file. Idempotent. */
  close(): Promise<void>;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 2000;
const DEFAULT_HOST = "127.0.0.1";

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number, readonly port: number) {
    super(`Daemon already running (pid ${pid}, port ${port})`);
    this.name = "DaemonAlreadyRunningError";
  }
}

/** The requested port is already bound; `port` and `host` name what was asked for. */
export class DaemonPortInUseError extends Error {
  constructor(readonly port: number, readonly host: string, options?: ErrorOptions) {
    super(`Port ${port} on ${host} is already in use`, options);
    this.name = "DaemonPortInUseError";
  }
}

export async function startDaemon<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>): Promise<DaemonHandle> {
  const log = options.logger ?? consoleLogger;
  assertBindAllowed(options);
  const remote = remoteListener(options);
  const paths = daemonPaths(options.stateDir);
  await assertNotAlreadyRunning(paths, options.processStartTime ?? getProcessStartTime, log);
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  const hub = new EventHub();
  let boundPort = options.port ?? DEFAULT_DAEMON_PORT;
  let ready = false;
  const shared = { ...toHttpOptions(options), hub, port: () => boundPort, ready: () => ready };
  const server = await listenLoopback(buildHttpApp(shared), options.host ?? DEFAULT_HOST, boundPort, mcpHandler(options, () => boundPort));
  boundPort = boundPortOf(server, boundPort);
  const servers = [server, ...(await listenRemoteOrClose({ remote, shared, port: boundPort, loopback: server, graceMs, log }))];

  const watcher = startWatcher(options, hub, log);
  await writePidFile(paths, process.pid, { port: boundPort, version: options.version, started: new Date().toISOString() });
  // Only now is a `/health` probe answerable: the pid file exists, so anything that finds
  // the daemon healthy can also find the daemon.
  ready = true;
  log.info({ pid: process.pid, port: boundPort }, "daemon started");

  return { port: boundPort, hub, close: onceAsync(() => shutdown({ servers, watcher, paths, log, graceMs })) };
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
    guards: guardOptions(options),
    rpcBodyLimit: options.rpcBodyLimit,
  };
}

/** A non-default bind address joins the Host allowlist: its clients dial exactly that. */
function guardOptions<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>): RequestGuardOptions {
  const guards = options.guards ?? {};
  if (guards.allowedHosts || !options.host) return guards;
  return { ...guards, allowedHosts: [...DEFAULT_ALLOWED_HOSTS, options.host] };
}

function assertBindAllowed<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>): void {
  const host = options.host ?? DEFAULT_HOST;
  if (options.allowUnauthenticatedNonLoopback !== true && !isLoopbackHost(host)) throw new NonLoopbackBindError(host);
}

interface RemoteListener {
  options: RemoteListenerOptions;
  gate: DaemonAuth;
}

/** Checked, and the token file read, before anything binds: a bad remote config never half-starts. */
function remoteListener<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>): RemoteListener | null {
  const remote = options.remote;
  if (!remote) return null;
  if (!isLoopbackHost(options.host ?? DEFAULT_HOST)) {
    throw new RemoteBindError(remote.host, "the main listener is already unauthenticated beyond loopback");
  }
  assertRemoteHost(remote.host);
  return { options: remote, gate: createDaemonAuth({ tokenFile: remote.tokenFile }) };
}

function remoteGuardOptions(remote: RemoteListenerOptions): RequestGuardOptions {
  const literal = isIPv6(remote.host) ? `[${remote.host}]` : remote.host;
  return { allowedHosts: [literal, ...(remote.allowedHosts ?? [])], portOnly: true };
}

interface RemoteBind<Ctx extends BaseContext> {
  remote: RemoteListener | null;
  shared: HttpAppOptions<Ctx>;
  port: number;
  loopback: ServerType;
  graceMs: number;
  log: Logger;
}

/** Both listeners or neither: a remote bind failure closes loopback before the pid file exists. */
async function listenRemoteOrClose<Ctx extends BaseContext>({ remote, shared, port, loopback, graceMs, log }: RemoteBind<Ctx>): Promise<ServerType[]> {
  if (!remote) return [];
  const app = buildHttpApp({ ...shared, guards: remoteGuardOptions(remote.options), gate: remote.gate });
  try {
    return [await listenRemote(app, remote.options.host, port)];
  } catch (err) {
    await closeServer(loopback, graceMs).catch((closeErr: unknown) => log.error({ err: closeErr }, "error closing loopback after a failed remote bind"));
    throw err;
  }
}

async function assertNotAlreadyRunning(paths: DaemonPaths, startTimeOf: (pid: number) => Date | null, log: Logger): Promise<void> {
  const existing = await readPidFile(paths);
  if (existing && (await isThisDaemon(paths, existing, startTimeOf))) {
    throw new DaemonAlreadyRunningError(existing.pid, existing.meta.port);
  }
  // Stale pid file: the process is gone, or the OS reused its pid after a reboot. Naming
  // the pid keeps the removal scoped to the file we just inspected.
  if (existing) {
    log.warn({ pid: existing.pid }, "removing stale daemon pid file");
    await removePidFile(paths, existing.pid);
  }
}

/**
 * A live pid is this daemon if it predates its pid file. Only a start time proven later
 * than the file marks the pid as reused; when the start time is unknown we cannot tell,
 * so we refuse rather than risk a second daemon. A reused pid that answers health on the
 * recorded port is still this daemon.
 */
async function isThisDaemon(paths: DaemonPaths, existing: PidFileContents, startTimeOf: (pid: number) => Date | null): Promise<boolean> {
  if (!isProcessAlive(existing.pid)) return false;
  const started = startTimeOf(existing.pid);
  const written = await pidFileModifiedAt(paths);
  if (!started || !written) return true;
  if (started.getTime() <= written.getTime()) return true;
  return existing.meta.port > 0 && (await probeHealth(existing.meta.port)) !== null;
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
  port: () => number,
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
  const guard = createRequestGuard(guardOptions(options), port);
  return (req, res) => handleMcpRequest(mcpOptions, guard, req, res);
}

function listenLoopback(
  app: Hono,
  hostname: string,
  port: number,
  mcp: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null,
): Promise<ServerType> {
  const { server, bound } = bind(app, hostname, port);
  if (mcp) spliceMcpRoute(server, mcp);
  return bound;
}

/** Takes no MCP handler: `/mcp` is spliced ahead of hono, so the auth gate would never see it. */
function listenRemote(app: Hono, hostname: string, port: number): Promise<ServerType> {
  return bind(app, hostname, port).bound;
}

function bind(app: Hono, hostname: string, port: number): { server: ServerType; bound: Promise<ServerType> } {
  let server!: ServerType;
  const bound = new Promise<ServerType>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname, port }, () => {
      server.off("error", onBindError);
      resolve(server);
    });
    // serve() attaches no error listener; without this a bind failure is an uncaught exception.
    const onBindError = (err: NodeJS.ErrnoException): void => {
      server.off("error", onBindError);
      reject(err.code === "EADDRINUSE" ? new DaemonPortInUseError(port, hostname, { cause: err }) : err);
    };
    server.on("error", onBindError);
  });
  return { server, bound };
}

function boundPortOf(server: ServerType, requested: number): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : requested;
}

interface ShutdownParts {
  servers: ServerType[];
  watcher: TreeWatcher | null;
  paths: DaemonPaths;
  log: Logger;
  graceMs: number;
}

async function shutdown({ servers, watcher, paths, log, graceMs }: ShutdownParts): Promise<void> {
  try {
    watcher?.close();
  } catch (err) {
    log.error({ err }, "error closing file watcher");
  }
  const closed = await Promise.allSettled(servers.map((server) => closeServer(server, graceMs)));
  for (const result of closed) {
    if (result.status === "rejected") log.error({ err: result.reason }, "error closing server");
  }
  try {
    // Only ours: a supervised successor may already own the pid file.
    await removePidFile(paths, process.pid);
  } catch (err) {
    log.error({ err }, "error removing pid file");
  }
}

/**
 * `server.close` stops accepting new connections but resolves only once every open one ends,
 * and an MCP or `/events` client holds one open for its whole session. Without the forced
 * sweep the process outlives SIGTERM indefinitely and a restart finds the port still held.
 */
function closeServer(server: ServerType, graceMs: number): Promise<void> {
  // The executor runs synchronously, so the server is already closing before either sweep —
  // node only destroys sockets on a server that has been told to close.
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  destroyConnections(server, "closeIdleConnections");
  const forced = setTimeout(() => destroyConnections(server, "closeAllConnections"), graceMs);
  forced.unref();
  return closed.finally(() => clearTimeout(forced));
}

type ConnectionSweep = "closeIdleConnections" | "closeAllConnections";

/** Http2 members of the `ServerType` union do not carry these; loopback daemons are http1. */
function destroyConnections(server: ServerType, sweep: ConnectionSweep): void {
  const close = (server as Partial<Record<ConnectionSweep, () => void>>)[sweep];
  if (typeof close === "function") close.call(server);
}

function onceAsync(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => (pending ??= fn());
}
