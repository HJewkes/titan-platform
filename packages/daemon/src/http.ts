/**
 * The hono app: `/health`, `/version`, `/events` (SSE), and `POST /rpc/:name`.
 *
 * Pure by construction — it builds and returns a `Hono` without binding a port, so routes
 * are testable through `app.request()`. `daemon.ts` owns the lifecycle.
 */
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
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
import type { EventHub } from "./events.js";
import { createRequestGuard, type RequestGuardOptions } from "./guards.js";
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
}

export function buildHttpApp<Ctx extends BaseContext>(options: HttpAppOptions<Ctx>): Hono {
  const app = new Hono();
  const startedAt = options.startedAt ?? Date.now();
  registerGuards(app, options);

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
      contentType: c.req.header("content-type"),
    });
    if (refusal) return c.json(errorEnvelope(refusal.message, EXIT.USAGE), refusal.status);
    await next();
  });
}

function registerEvents<Ctx extends BaseContext>(app: Hono, options: HttpAppOptions<Ctx>): void {
  app.get(EVENTS_PATH, (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: SSE_EVENTS.READY, data: SSE_READY_DATA });
      const unsubscribe = options.hub?.subscribe((message) => stream.writeSSE(message));
      stream.onAbort(() => unsubscribe?.());
      // Hold the connection open, emitting periodic heartbeats so proxies and dead-peer
      // detection keep the stream healthy until the client aborts.
      while (!stream.aborted) {
        await stream.sleep(SSE_HEARTBEAT_MS);
        if (stream.aborted) break;
        await stream.writeSSE({ event: SSE_EVENTS.PING, data: String(Date.now()) });
      }
      unsubscribe?.();
    }),
  );
}

const INVALID_JSON = Symbol("invalid-json");

function registerRpc<Ctx extends BaseContext>(app: Hono, options: HttpAppOptions<Ctx>): void {
  app.post(`${RPC_PREFIX}:name`, async (c) => {
    const name = c.req.param("name");
    const cmd = options.registry.get(name);
    if (!cmd) return c.json(errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE), RPC_STATUS.NOT_FOUND);

    const rawArgs = await readJsonBody(c);
    if (rawArgs === INVALID_JSON) return c.json(errorEnvelope("Invalid JSON body", EXIT.USAGE), RPC_STATUS.BAD_REQUEST);

    const { envelope, exitCode } = await invokeCommand(cmd, rawArgs, options.createContext("http"), {
      invalidArgsCode: EXIT.DATAERR,
      formatError: options.formatError,
    });
    if (envelope.ok) return c.json(envelope);
    return c.json(envelope, rpcFailureStatus(exitCode));
  });
}

/** Body is optional; an empty one means "no arguments". Reads text so no header is load-bearing. */
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
