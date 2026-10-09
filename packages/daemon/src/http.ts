/**
 * The hono app: `/health`, `/version`, `/events` (SSE), and `POST /rpc/:name`.
 *
 * Pure by construction — it builds and returns a `Hono` without binding a port, so routes
 * are testable through `app.request()`. `daemon.ts` owns the lifecycle.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { EXIT, errorEnvelope, invokeCommand, type BaseContext } from "@titan-design/registry";
import {
  EVENTS_PATH,
  HEALTH_PATH,
  RPC_PREFIX,
  RPC_STATUS,
  SSE_EVENTS,
  SSE_HEARTBEAT_MS,
  SSE_READY_DATA,
  VERSION_PATH,
  rpcFailureStatus,
} from "@titan-design/rpc-protocol";
import { authGate, carryRequestAuth, getRequestAuth, mountLogoutRoute, type DaemonAuth } from "./auth.js";
import type { EventHub } from "./events.js";
import { CLIENT_HEADER, createRequestGuard, type RequestGuardOptions } from "./guards.js";
import { buildHealthPayload } from "./health.js";
import type { SurfaceOptions } from "./surface.js";

export interface HttpAppOptions<Ctx extends BaseContext = BaseContext> extends SurfaceOptions<Ctx> {
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

export interface RpcBodyLimit {
  /** Applies to every command not named in `perCommand`. Defaults to {@link DEFAULT_RPC_BODY_LIMIT}. */
  maxBytes?: number;
  /** A tighter (or looser) cap for one command, keyed by its registry name. */
  perCommand?: Readonly<Record<string, number>>;
}

/** Large enough for any argument object a command takes, small enough that a body cannot exhaust memory. */
export const DEFAULT_RPC_BODY_LIMIT = 1024 * 1024;

export function buildHttpApp<Ctx extends BaseContext>(options: HttpAppOptions<Ctx>): Hono {
  const app = new Hono();
  const startedAt = options.startedAt ?? Date.now();
  registerGuards(app, options);
  if (options.gate) {
    app.use("*", authGate(options.gate));
    mountLogoutRoute(app);
  }

  app.get(HEALTH_PATH, (c) => {
    if (options.ready && !options.ready()) return c.json({ ok: false, starting: true }, 503);
    const payload = buildHealthPayload({
      port: options.port(),
      version: options.version,
      startedAt,
      extension: options.health?.(),
    });
    return c.json(payload);
  });

  app.get(VERSION_PATH, (c) => c.json({ version: options.version }));
  registerEvents(app, options);
  registerRpc(app, options);
  options.mountRoutes?.(app);
  return app;
}

function registerGuards<Ctx extends BaseContext>(app: Hono, options: HttpAppOptions<Ctx>): void {
  const guard = createRequestGuard(options.guards, options.port);
  app.use("*", async (c, next) => {
    const refusal = guard({
      method: c.req.method,
      // No Host header means HTTP/1.0 or a synthetic Request; the URL's host is then the
      // server's own bind address, never anything a client supplied.
      host: c.req.header("host") ?? new URL(c.req.url).host,
      origin: c.req.header("origin"),
      client: c.req.header(CLIENT_HEADER),
      contentType: c.req.header("content-type"),
    });
    if (refusal) return c.json(errorEnvelope(refusal.message, EXIT.USAGE), refusal.status);
    await next();
  });
}

export interface EventLimits {
  /** Concurrent `/events` streams across every listener sharing the hub; one more answers 503. Defaults to 64. */
  maxSubscribers: number;
  /** Broadcasts a stream may hold unwritten; one more disconnects it, so a client never silently misses one. Defaults to 256. */
  maxQueued: number;
}

export const DEFAULT_EVENT_LIMITS: EventLimits = { maxSubscribers: 64, maxQueued: 256 };

function registerEvents<Ctx extends BaseContext>(app: Hono, options: HttpAppOptions<Ctx>): void {
  const limits = { ...DEFAULT_EVENT_LIMITS, ...options.eventLimits };
  app.get(EVENTS_PATH, (c) => {
    if (options.hub && options.hub.size >= limits.maxSubscribers) {
      return c.json(errorEnvelope("Too many event subscribers", EXIT.UNAVAILABLE), 503);
    }
    return streamSSE(c, async (stream) => {
      // Subscribed before the first await, so the size check above and this join are one step.
      const unsubscribe = options.hub ? subscribeBounded(options.hub, stream, limits.maxQueued) : undefined;
      stream.onAbort(() => unsubscribe?.());
      await stream.writeSSE({ event: SSE_EVENTS.READY, data: SSE_READY_DATA });
      // Hold the connection open, emitting periodic heartbeats so proxies and dead-peer
      // detection keep the stream healthy until the client aborts.
      while (!stream.aborted) {
        await stream.sleep(SSE_HEARTBEAT_MS);
        if (stream.aborted) break;
        await stream.writeSSE({ event: SSE_EVENTS.PING, data: String(Date.now()) });
      }
      unsubscribe?.();
    });
  });
}

/** A write stays pending while the client is not reading, so the count is that client's backlog. */
function subscribeBounded(hub: EventHub, stream: SSEStreamingApi, maxQueued: number): () => void {
  let queued = 0;
  const unsubscribe = hub.subscribe((message) => {
    if (queued >= maxQueued) {
      unsubscribe();
      stream.abort();
      return;
    }
    queued += 1;
    void stream
      .writeSSE(message)
      .catch(() => stream.abort())
      .finally(() => {
        queued -= 1;
      });
  });
  return unsubscribe;
}

const INVALID_JSON = Symbol("invalid-json");

/**
 * Refuses an oversized body with 413 from its Content-Length, or mid-stream once a chunked one
 * passes the cap. A Content-Length is checked from the header alone: Node's parser never reads
 * past it, and touching `raw.body` would make the node adapter build a second Request.
 */
function rpcBodyLimitMiddleware(limit: RpcBodyLimit = {}): MiddlewareHandler {
  const fallback = limit.maxBytes ?? DEFAULT_RPC_BODY_LIMIT;
  const perCommand = limit.perCommand ?? {};
  const onError = (c: Context) => c.json(errorEnvelope("Request body is too large", EXIT.USAGE), 413);
  return (c, next) => {
    const name = c.req.param("name") ?? "";
    const maxSize = Object.hasOwn(perCommand, name) ? perCommand[name]! : fallback;
    const length = c.req.header("content-length");
    if (length !== undefined && c.req.header("transfer-encoding") === undefined) {
      return Number(length) > maxSize ? Promise.resolve(onError(c)) : next();
    }
    const original = c.req.raw;
    return bodyLimit({ maxSize, onError })(c, () => {
      carryRequestAuth(original, c.req.raw);
      return next();
    });
  };
}

function registerRpc<Ctx extends BaseContext>(app: Hono, options: HttpAppOptions<Ctx>): void {
  app.post(`${RPC_PREFIX}:name`, rpcBodyLimitMiddleware(options.rpcBodyLimit), async (c) => {
    const name = c.req.param("name");
    const cmd = options.registry.get(name);
    if (!cmd) return c.json(errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE), RPC_STATUS.NOT_FOUND);

    const rawArgs = await readJsonBody(c);
    if (rawArgs === INVALID_JSON) return c.json(errorEnvelope("Invalid JSON body", EXIT.USAGE), RPC_STATUS.BAD_REQUEST);

    const auth = getRequestAuth(c.req.raw);
    // On a gated app an absent record means the gate did not vouch for this request; never
    // let it reach createContext looking like an ungated loopback call.
    if (options.gate && !auth) return c.json(errorEnvelope("Authentication required", EXIT.USAGE), 401);
    const context = options.createContext("http", auth);
    const { envelope, exitCode } = await invokeCommand(cmd, rawArgs, context, {
      invalidArgsCode: EXIT.DATAERR,
      formatError: options.formatError,
    });
    if (envelope.ok) return c.json(envelope);
    return c.json(envelope, rpcFailureStatus(exitCode));
  });
}

/** Body is optional; an empty one means "no arguments". guards.ts already 415s a non-JSON POST. */
async function readJsonBody(c: Context): Promise<unknown> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return INVALID_JSON;
  }
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return INVALID_JSON;
  }
}
