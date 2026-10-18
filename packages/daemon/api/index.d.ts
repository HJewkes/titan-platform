import { BaseContext, CommandRegistry, ErrorDescription, JsonEnvelope, McpToolDescriptor } from '@titan-design/registry';
import { Hono } from 'hono';
import { SseMessage } from '@titan-design/rpc-protocol';
export { CLIENT_HEADER, SseMessage } from '@titan-design/rpc-protocol';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

type TokenFileProblem = "symlink" | "not-regular" | "owner" | "mode" | "empty" | "short" | "malformed";
/** The token file exists but cannot be trusted. The message never contains the secret. */
declare class TokenFileError extends Error {
    readonly problem: TokenFileProblem;
    constructor(problem: TokenFileProblem, file: string, detail: string);
}
/**
 * Create the token file if it is missing (mode 0600, O_EXCL, so a file or symlink planted
 * first is never written through), then read it back under the same checks as a reload.
 */
declare function ensureTokenFile(file: string): string;
/** Replace the secret by writing a 0600 temp file and renaming it over the old one. */
declare function rotateTokenFile(file: string): string;

declare const SESSION_COOKIE = "titan_session";
declare const LOGIN_PATH = "/auth/login";
declare const LOGOUT_PATH = "/auth/logout";
declare const LOGIN_CODE_TTL_MS: number;
declare const DEFAULT_SIGN_IN_HINT = "Ask the operator for a fresh sign-in link.";
declare const SESSION_MAX_AGE_MS: number;
/** `v1.<issuedAt>.<HMAC(cookieKey, "v1.<issuedAt>")>`; stateless, so it survives restarts. */
declare function signSession(secret: string, issuedAt?: number): string;
/** The session's issue time, or null when it is malformed, forged, from the future, or 30 days old. */
declare function verifySession(secret: string, value: string, now?: number): {
    issuedAt: number;
} | null;
/** `v1.<issuedAt>.<nonce>.<HMAC(codeKey, ...)>`. Minting needs only the secret, not the daemon. */
declare function mintLoginCode(secret: string, now?: number): string;
/** The per-process memory of spent codes, and the start time that bounds which codes count. */
interface LoginCodeLedger {
    readonly startedAt: number;
    readonly used: Set<string>;
}
declare function createLoginCodeLedger(startedAt?: number): LoginCodeLedger;
/**
 * Synchronous on purpose: the used-set check and the mark have no await between them, so two
 * concurrent requests carrying one code cannot both pass. Entries are never pruned; only a
 * correctly signed code is ever added, so the set grows by one per real login.
 */
declare function consumeLoginCode(ledger: LoginCodeLedger, secret: string, code: string, now?: number): boolean;
interface DaemonAuthOptions {
    /** The token file. It must already exist; see {@link ensureTokenFile}. */
    tokenFile: string;
    /** Codes minted before this are refused. Defaults to now. */
    startedAt?: number;
    /**
     * Tells a signed-out browser how to get a sign-in link, shown on the sign-in pages. A product
     * names its own command here. Defaults to {@link DEFAULT_SIGN_IN_HINT}.
     */
    signInHint?: string;
}
interface DaemonAuth {
    /** The current secret, re-read when the file's inode, size, times, mode or owner change. */
    secret(): string;
    readonly ledger: LoginCodeLedger;
    readonly signInHint: string;
}
/** Throws {@link TokenFileError} now, so a daemon with an untrustworthy file never starts. */
declare function createDaemonAuth(options: DaemonAuthOptions): DaemonAuth;
/** How the request authenticated; `issuedAt` is the session's, null for a bearer. */
interface RequestAuth {
    credential: "session" | "bearer";
    issuedAt: number | null;
    /**
     * The peer is this machine: a loopback address or one of its own interface addresses, or an
     * address the gate could not read. Any local process can read the token file, so a command
     * that must come from another device refuses when this is true.
     */
    peerLocal: boolean;
}
/** What {@link authGate} recorded for this request, or undefined if no gate ran. */
declare function getRequestAuth(request: Request): RequestAuth | undefined;

/** Which projection of the registry is running the command. */
type Surface = "http" | "mcp";
/**
 * What every surface needs to run a command. `createContext` is the seam that keeps this
 * package domain-free: the daemon never knows what a product's context contains. `auth` is
 * what the `gate` recorded, so a command can refuse a credential kind. It is undefined only on
 * an ungated listener and on MCP: a gated app answers 401 rather than call this without it.
 */
interface SurfaceOptions<Ctx extends BaseContext = BaseContext> {
    registry: CommandRegistry<Ctx>;
    createContext: (surface: Surface, auth?: RequestAuth) => Ctx;
    /** Map a thrown value to a message and code; defaults to the registry's `describeError`. */
    formatError?: (err: unknown) => ErrorDescription;
}

type Subscriber = (message: SseMessage) => void | Promise<void>;
/** Transport-agnostic fan-out: `/events` subscribes each SSE stream, the daemon broadcasts. */
declare class EventHub {
    private readonly subscribers;
    /** Register a subscriber; returns an unsubscribe function. */
    subscribe(send: Subscriber): () => void;
    get size(): number;
    /**
     * Push a message to every subscriber. A slow or broken subscriber never blocks the
     * others and never throws out of `broadcast`; failures drop that subscriber so a dead
     * connection cannot wedge future broadcasts.
     */
    broadcast(message: SseMessage): void;
}

/**
 * Host, Origin, client-header, and Content-Type guards for the daemon's request surfaces.
 *
 * An unauthenticated daemon on loopback is reachable from every browser on the machine.
 * A page that re-resolves its own name to 127.0.0.1 makes requests the browser treats as
 * same-origin, so no CORS rule stops them. What the browser cannot forge is the `Host`
 * header (it carries the attacker's name) or the `Origin` header, and what it cannot send
 * without a preflight is a JSON body or a custom header.
 *
 * Threat model for a state-changing request (POST, PUT, PATCH, DELETE):
 *
 * - A present `Origin` must be allowlisted. Browsers set it and page script cannot.
 * - A missing `Origin` proves nothing. Current browsers attach one to every non-GET
 *   request, but older browsers, privacy extensions, and embedded webviews have omitted
 *   it. So absence says "probably not a browser"; it does not say "not a browser".
 * - A missing `Origin` must therefore come with {@link CLIENT_HEADER}. Any value passes,
 *   because the header is not a secret: its proof is that a page can only attach a custom
 *   header after a CORS preflight, and this daemon answers no preflight. A request that
 *   carries it came from a non-browser client, or from a page that already passed the
 *   Origin check. Adding CORS headers that allow it would void this proof.
 * - Loopback alone is not enough, and the guard does not look at the peer address. The
 *   attacker's page runs in a browser on this machine, so its requests arrive from
 *   127.0.0.1 exactly as a CLI's do.
 * - None of this authenticates anyone. Any local process can send the header; the
 *   guards only keep web pages out, and the OS account stays the trust boundary.
 *
 * The Host-allowlist shape is adapted from beads (MIT), `internal/httpapi/server.go`.
 */

interface RequestGuardOptions {
    /** Host values answered to, each matched with and without the bound port. */
    allowedHosts?: string[];
    /** Origins accepted beyond the http/https forms of `allowedHosts`. */
    allowedOrigins?: string[];
    /**
     * Match `allowedHosts`, and derive origins, only with the bound port. A listener reached
     * beyond loopback needs this: cookies ignore port, so a portless origin would admit a page
     * from any other service on the same host, and that page's requests carry the cookie.
     */
    portOnly?: boolean;
    /** Derive only `https://` origins from `allowedHosts`: on a TLS listener an `http://` origin is another site. */
    httpsOnly?: boolean;
}
interface GuardRefusal {
    status: 403 | 415;
    message: string;
}
/** The headers a guard reads, from either a hono context or a raw Node request. */
interface GuardedRequest {
    method: string;
    host: string | null | undefined;
    origin: string | null | undefined;
    /** The {@link CLIENT_HEADER} value, which stands in for `Origin` on non-browser calls. */
    client: string | null | undefined;
    contentType: string | null | undefined;
}
type RequestGuard = (request: GuardedRequest) => GuardRefusal | null;
/** Every loopback spelling a client can dial without the operator configuring anything. */
declare const DEFAULT_ALLOWED_HOSTS: string[];
/**
 * Build the guard. `port` is a thunk because `port: 0` is only resolved once bound, and
 * the policy is rebuilt whenever that answer changes.
 */
declare function createRequestGuard(options?: RequestGuardOptions, port?: () => number): RequestGuard;

/**
 * The hono app: `/health`, `/version`, `/events` (SSE), and `POST /rpc/:name`.
 *
 * Pure by construction — it builds and returns a `Hono` without binding a port, so routes
 * are testable through `app.request()`. `daemon.ts` owns the lifecycle.
 */

interface HttpAppOptions<Ctx extends BaseContext = BaseContext> extends SurfaceOptions<Ctx> {
    /** Reported by `/health`. A thunk because `port: 0` is only resolved once bound. */
    port: () => number;
    /** Reported by `/health` and `/version`. */
    version: string;
    /** `Date.now()` at start; defaults to when the app was built. */
    startedAt?: number;
    /** When present, `/events` streams its broadcasts; otherwise only heartbeats. */
    hub?: EventHub;
    /** Bounds on `/events` subscribers; see `EventLimits` for the defaults. */
    eventLimits?: Partial<EventLimits>;
    /**
     * Whether startup has finished. Until it has, `/health` answers 503: the port binds
     * before the pid file exists, so a caller treating a bound port as "ready" could find
     * the daemon healthy and then fail to look it up.
     */
    ready?: () => boolean;
    /** Product state merged into the `/health` payload. */
    health?: () => Record<string, unknown>;
    /** Hook for product-owned routes (a dashboard, static assets, extra endpoints). */
    mountRoutes?: (app: Hono) => void;
    /** Host/Origin allowlists and the JSON body gate. Defaults to loopback only. */
    guards?: RequestGuardOptions;
    /**
     * Require a session or bearer on every route, built-ins and `mountRoutes` alike, except
     * `/auth/login`. It runs right after the Host/Origin guard and also adds `/auth/logout`.
     */
    gate?: DaemonAuth;
    /** The byte cap on a `/rpc` body, enforced before the body is buffered. */
    rpcBodyLimit?: RpcBodyLimit;
}
interface RpcBodyLimit {
    /** Applies to every command not named in `perCommand`. Defaults to {@link DEFAULT_RPC_BODY_LIMIT}. */
    maxBytes?: number;
    /** A tighter (or looser) cap for one command, keyed by its registry name. */
    perCommand?: Readonly<Record<string, number>>;
}
/** Large enough for any argument object a command takes, small enough that a body cannot exhaust memory. */
declare const DEFAULT_RPC_BODY_LIMIT: number;
declare function buildHttpApp<Ctx extends BaseContext>(options: HttpAppOptions<Ctx>): Hono;
interface EventLimits {
    /** Concurrent `/events` streams across every listener sharing the hub; one more answers 503. Defaults to 64. */
    maxSubscribers: number;
    /** Broadcasts a stream may hold unwritten; one more disconnects it, so a client never silently misses one. Defaults to 256. */
    maxQueued: number;
}
declare const DEFAULT_EVENT_LIMITS: EventLimits;

interface HealthPayload extends Record<string, unknown> {
    ok: true;
    version: string;
    pid: number;
    uptime_ms: number;
    port: number;
}
interface HealthPayloadInput {
    port: number;
    version: string;
    /** `Date.now()` at daemon start; uptime is measured against it. */
    startedAt: number;
    /** Product state merged into the payload. Core fields win on a key collision. */
    extension?: Record<string, unknown>;
}
declare function buildHealthPayload(input: HealthPayloadInput): HealthPayload;

interface WatchTreeOptions {
    /** Coalesce bursts of events within this window (ms). */
    debounceMs?: number;
    /** Surface watcher errors (e.g. EMFILE) without crashing the host process. */
    onError?: (err: unknown) => void;
}
interface TreeWatcher {
    close: () => void;
    /** Whether a watcher is currently attached to `dir`. */
    isWatching: (dir: string) => boolean;
    /**
     * Resolve once a watcher is attached to `dir` — the real "this path is now covered"
     * signal, so callers never have to guess with a sleep. Resolves `true` immediately if
     * already attached, `false` if `timeoutMs` elapses or the tree watcher closes first.
     */
    whenWatching: (dir: string, timeoutMs?: number) => Promise<boolean>;
}
/**
 * Watch `root` and all nested directories, invoking `onChange` (debounced) whenever any
 * file or directory under the tree changes. `close()` tears down every watcher.
 */
declare function watchTree(root: string, onChange: () => void, options?: WatchTreeOptions): TreeWatcher;

interface DaemonPaths {
    pidFile: string;
    metaFile: string;
}
interface DaemonMeta {
    port: number;
    version: string;
    started: string;
}
interface PidFileContents {
    pid: number;
    meta: DaemonMeta;
}
declare const DEFAULT_DAEMON_PORT = 7400;
/** The conventional layout inside a state directory: `daemon.pid` + `daemon.meta.json`. */
declare function daemonPaths(stateDir: string): DaemonPaths;
declare function writePidFile(paths: DaemonPaths, pid: number, meta: DaemonMeta): Promise<void>;
declare function readPidFile(paths: DaemonPaths): Promise<PidFileContents | null>;
/**
 * Delete the pid file — but only while it still names `expectedPid`.
 *
 * Supervised restarts overlap by design: the successor binds the port and writes its own
 * pid file before the departing instance's SIGTERM handler cleans up. An unconditional
 * unlink there deletes the *successor's* file, leaving a live daemon that every status
 * command reports as absent. A mismatch means someone else owns the daemon now.
 *
 * Returns whether the file was removed.
 */
declare function removePidFile(paths: DaemonPaths, expectedPid: number): Promise<boolean>;
declare function isProcessAlive(pid: number): boolean;
/**
 * The command name currently running at `pid` (e.g. `node`), or `null` if the pid has no
 * process or the lookup fails.
 *
 * `kill(pid, 0)` only proves *some* process holds that pid — the OS reuses pids, so a
 * recorded lease can outlive the process it named. Pair the liveness check with this
 * identity check: record the command at write time, re-read it later, and a mismatch
 * means the pid was recycled.
 */
declare function getProcessCommand(pid: number): string | null;
/**
 * When the process at `pid` started, or `null` if the pid has no process or the lookup
 * fails. `ps` reports whole seconds, which rounds a start time down and so never makes a
 * genuine daemon look newer than its own pid file.
 */
declare function getProcessStartTime(pid: number): Date | null;
interface ProbeHealthOptions {
    host?: string;
    timeoutMs?: number;
}
/** GET `/health` on a running daemon; null on any failure, so callers can treat it as "not up". */
declare function probeHealth(port: number, options?: ProbeHealthOptions): Promise<Record<string, unknown> | null>;

/**
 * The logging surface the daemon needs, expressed as a parameter rather than a
 * dependency. The shape is pino's `(fields, message)` call signature, so a pino instance
 * satisfies it structurally and a product can pass its own logger instead.
 */
interface Logger {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
}
/** Default logger: one line per record on stderr, so stdout stays clean for stdio MCP. */
declare const consoleLogger: Logger;
/** Drops every record. Useful in tests and for products that log elsewhere. */
declare const silentLogger: Logger;

/**
 * MCP projection of the registry: every command becomes a tool, with `inputSchema` derived
 * from its zod args. The same handlers serve stdio and the daemon's `/mcp` route.
 */

interface McpServerOptions<Ctx extends BaseContext = BaseContext> extends SurfaceOptions<Ctx> {
    /** Prepended to every tool name so one client can host several registries, e.g. `active__`. */
    toolPrefix: string;
    /** Server identity reported in the MCP handshake. */
    name: string;
    version: string;
}
interface ToolCallOutcome {
    isError: boolean;
    envelope: JsonEnvelope<unknown>;
}
/** Every registered command as an MCP tool, sorted by the registry. */
declare function listTools<Ctx extends BaseContext>(options: McpServerOptions<Ctx>): McpToolDescriptor[];
/** Resolve a tool name to its command and run it. Always returns an envelope; never throws. */
declare function invokeTool<Ctx extends BaseContext>(options: McpServerOptions<Ctx>, toolName: string, rawArgs: unknown): Promise<ToolCallOutcome>;
/** Wire the tool handlers onto a server instance. Exposed so tests can use a linked transport pair. */
declare function attachHandlers<Ctx extends BaseContext>(server: Server, options: McpServerOptions<Ctx>): void;
/** A fully-wired MCP server, sans transport. */
declare function createMcpServer<Ctx extends BaseContext>(options: McpServerOptions<Ctx>): Server;
/** Serve MCP over stdio. Resolves when the transport closes (the client disconnected). */
declare function runMcpStdio<Ctx extends BaseContext>(options: McpServerOptions<Ctx>): Promise<void>;

declare class NonLoopbackBindError extends Error {
    readonly host: string;
    constructor(host: string);
}
declare class RemoteBindError extends Error {
    readonly host: string;
    constructor(host: string, reason: string);
}
/** Pure syntax check: names other than `localhost` are never resolved. */
declare function isLoopbackHost(host: string): boolean;

interface RemoteTlsOptions {
    /** PEM certificate chain. Every name the listener answers to must be on it. */
    certFile: string;
    /** PEM private key. Owned by this user and readable by no one else, like the token file. */
    keyFile: string;
}
/** The pair cannot be served. The message names the file and never contains key material. */
declare class TlsFileError extends Error {
    readonly file: string;
    constructor(file: string, detail: string, options?: ErrorOptions);
}

/**
 * The remote listener speaks only TLS, then runs the Host/Origin guard, then the auth gate,
 * before every route, and never serves `/mcp`. Its Host allowlist is `host` plus `allowedHosts`
 * and nothing else, each matched only with the bound port, and its origins are the `https://`
 * forms of that list alone. The loopback listener is unchanged and never learns these names.
 * `mountRoutes` runs once per listener, each on its own app.
 */
interface RemoteListenerOptions {
    /** A bare IP address on one of this host's interfaces. Loopback, wildcards and names throw `RemoteBindError`. */
    host: string;
    /** The shared secret. It must already exist; see `ensureTokenFile`. */
    tokenFile: string;
    /** Names the remote listener also answers to, such as a tailnet name. The certificate must cover each. */
    allowedHosts?: string[];
    /**
     * Required: a remote listener without it throws `RemoteBindError`, so no setting serves plain
     * HTTP beyond loopback. The files are checked before anything binds and stat'd every
     * `tlsReloadMs`; a changed pair that fails its checks is logged and the last good pair stays.
     */
    tls: RemoteTlsOptions;
    /** How often the TLS files are checked for a change. Defaults to 60000. */
    tlsReloadMs?: number;
    /** How a signed-out browser gets a sign-in link, shown on the sign-in pages; see `DaemonAuthOptions.signInHint`. */
    signInHint?: string;
}

interface StartDaemonOptions<Ctx extends BaseContext = BaseContext> extends SurfaceOptions<Ctx> {
    /** Reported by `/health`, `/version`, and the pid metadata. */
    version: string;
    /** Directory for `daemon.pid` and `daemon.meta.json`; created if missing. */
    stateDir: string;
    /** Seam for the stale pid check: when the process at a pid started. Defaults to `ps`. */
    processStartTime?: (pid: number) => Date | null;
    /** Defaults to 7400. Pass 0 for an ephemeral port; the handle reports the bound one. */
    port?: number;
    /**
     * An already-listening loopback socket to serve on instead of binding `host:port`, such as
     * the one `systemdListenFd()` returns. The handle reports the socket's own port, and close
     * releases only this process's copy, so the socket's owner keeps it listening.
     */
    listenFd?: number;
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
    /** Bounds on `/events` subscribers; the subscriber cap counts both listeners together. */
    eventLimits?: Partial<EventLimits>;
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
interface DaemonHandle {
    /** The bound port — the real one when `port: 0` was requested. */
    port: number;
    /** Broadcast to connected `/events` clients. */
    hub: EventHub;
    /** Stop the watcher, close every listener, and release the pid file. Idempotent. */
    close(): Promise<void>;
}
declare class DaemonAlreadyRunningError extends Error {
    readonly pid: number;
    readonly port: number;
    constructor(pid: number, port: number);
}
/** The requested port is already bound; `port` and `host` name what was asked for. */
declare class DaemonPortInUseError extends Error {
    readonly port: number;
    readonly host: string;
    constructor(port: number, host: string, options?: ErrorOptions);
}
declare function startDaemon<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>): Promise<DaemonHandle>;
/** Start, then run until SIGTERM/SIGINT, then close. Resolves after shutdown completes. */
declare function runDaemonUntilSignal<Ctx extends BaseContext>(options: StartDaemonOptions<Ctx>): Promise<void>;

/**
 * The systemd socket-activation handoff (sd_listen_fds(3)): a supervisor that owns the
 * listening socket passes it as fd 3 and names the receiving process in `LISTEN_PID`.
 */
/**
 * The listening fd systemd passed to `pid`, or `undefined` when none was passed to it. A
 * `LISTEN_PID` naming another pid was meant for a parent and is left alone. On a match the
 * variables are removed from `env`, so no child process mistakes the socket for its own.
 */
declare function systemdListenFd(env?: NodeJS.ProcessEnv, pid?: number): number | undefined;

interface StaticAppOptions {
    /** A built app directory holding `index.html`, or a single-file build's HTML file. */
    root: string;
    /** URL prefix the app lives under, such as `/ui`. Defaults to `/`. */
    base?: string;
    /** Directory under `root` whose files carry content hashes and never change. Defaults to `assets`. */
    immutableDir?: string;
}
/** Mounts `GET <base>/*`: files from `root`, `index.html` for client routes, 404 for missing assets. */
declare function mountStaticApp(app: Hono, options: StaticAppOptions): void;

export { DEFAULT_ALLOWED_HOSTS, DEFAULT_DAEMON_PORT, DEFAULT_EVENT_LIMITS, DEFAULT_RPC_BODY_LIMIT, DEFAULT_SIGN_IN_HINT, DaemonAlreadyRunningError, type DaemonAuth, type DaemonAuthOptions, type DaemonHandle, type DaemonMeta, type DaemonPaths, DaemonPortInUseError, EventHub, type EventLimits, type GuardRefusal, type GuardedRequest, type HealthPayload, type HealthPayloadInput, type HttpAppOptions, LOGIN_CODE_TTL_MS, LOGIN_PATH, LOGOUT_PATH, type Logger, type LoginCodeLedger, type McpServerOptions, NonLoopbackBindError, type PidFileContents, type ProbeHealthOptions, RemoteBindError, type RemoteListenerOptions, type RemoteTlsOptions, type RequestAuth, type RequestGuard, type RequestGuardOptions, type RpcBodyLimit, SESSION_COOKIE, SESSION_MAX_AGE_MS, type StartDaemonOptions, type StaticAppOptions, type Subscriber, type Surface, type SurfaceOptions, TlsFileError, TokenFileError, type TokenFileProblem, type ToolCallOutcome, type TreeWatcher, type WatchTreeOptions, attachHandlers, buildHealthPayload, buildHttpApp, consoleLogger, consumeLoginCode, createDaemonAuth, createLoginCodeLedger, createMcpServer, createRequestGuard, daemonPaths, ensureTokenFile, getProcessCommand, getProcessStartTime, getRequestAuth, invokeTool, isLoopbackHost, isProcessAlive, listTools, mintLoginCode, mountStaticApp, probeHealth, readPidFile, removePidFile, rotateTokenFile, runDaemonUntilSignal, runMcpStdio, signSession, silentLogger, startDaemon, systemdListenFd, verifySession, watchTree, writePidFile };
